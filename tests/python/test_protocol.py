import json
import queue
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "plugins/roku-device-toolkit/mcp/server.py"
LAUNCHER = ROOT / "plugins/roku-device-toolkit/scripts/launch-mcp.mjs"


class ProtocolTests(unittest.TestCase):
    def messages(self):
        return "\n".join(json.dumps(message) for message in (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2099-01-01"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "ping", "params": {}},
            {"id": 4, "method": "ping", "params": {}},
        )) + "\n[]\n{bad\n"

    def assert_protocol(self, command):
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        lines = queue.Queue()

        def read_responses():
            for line in process.stdout:
                lines.put(line)
            lines.put(None)

        reader = threading.Thread(target=read_responses, daemon=True)
        reader.start()
        responses = []
        try:
            process.stdin.write(self.messages())
            process.stdin.flush()
            deadline = time.monotonic() + 20
            while len(responses) < 6:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.fail(f"Timed out waiting for protocol responses; received: {responses}")
                try:
                    line = lines.get(timeout=remaining)
                except queue.Empty:
                    self.fail(f"Timed out waiting for protocol responses; received: {responses}")
                if line is None:
                    self.fail(f"MCP server exited before all responses; received: {responses}")
                responses.append(json.loads(line))
            process.stdin.close()
            return_code = process.wait(timeout=10)
            stderr = process.stderr.read()
            self.assertEqual(return_code, 0, stderr)
        finally:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            reader.join(timeout=1)
            process.stdout.close()
            process.stderr.close()

        by_id = {item.get("id"): item for item in responses if item.get("id") is not None}
        self.assertEqual(by_id[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "roku-device-toolkit")
        self.assertIn("result", by_id[2], by_id[2])
        tools = by_id[2]["result"]["tools"]
        self.assertEqual(len(tools), 13)
        self.assertEqual(by_id[4]["error"]["code"], -32600)
        self.assertTrue(any(item.get("error", {}).get("code") == -32700 for item in responses))
        self.assertTrue(any(item.get("error", {}).get("code") == -32600 and item.get("id") is None for item in responses))

    def test_python_server_protocol(self):
        self.assert_protocol([sys.executable, str(SERVER)])

    def test_node_launcher_protocol(self):
        self.assert_protocol(["node", str(LAUNCHER)])


if __name__ == "__main__":
    unittest.main()
