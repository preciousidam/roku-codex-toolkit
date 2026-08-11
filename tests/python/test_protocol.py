import json
import subprocess
import sys
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
        completed = subprocess.run(command, input=self.messages(), text=True, capture_output=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        by_id = {item.get("id"): item for item in responses if item.get("id") is not None}
        self.assertEqual(by_id[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "roku-device-toolkit")
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
