import importlib.util
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "plugins/roku-device-toolkit/mcp/server.py"
SPEC = importlib.util.spec_from_file_location("roku_server_behavior", PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ServerBehaviorTests(unittest.TestCase):
    def tearDown(self):
        server.IN_FLIGHT.clear()
        server.PENDING_REQUESTS.clear()
        server.CANCELLED_REQUESTS.clear()
        server.DEVICE_MUTATION_LOCKS.clear()

    def test_command_construction_uses_separator_and_bounded_timeouts(self):
        executions = []
        result = {"command_succeeded": True, "return_code": 0, "stdout": "", "stderr": ""}
        with mock.patch.object(server, "host_args", return_value=["--host", "roku"]), \
             mock.patch.object(server, "execute", side_effect=lambda command, timeout=30, **_kwargs: executions.append((command, timeout)) or result):
            server.call_tool("enter_text", {"text": "-hello"})
            server.call_tool("press", {"keys": ["-h"]})
            server.call_tool("launch", {"channel_id": "-h"})
        self.assertEqual(executions[0][0][-2:], ["--", "-hello"])
        self.assertGreaterEqual(executions[0][1], 90)
        self.assertEqual(executions[1][0][-2:], ["--", "-h"])
        self.assertGreaterEqual(executions[1][1], 40)
        self.assertEqual(executions[2][0][-2:], ["--", "-h"])

    def test_invalid_numeric_and_schema_arguments_are_rejected(self):
        cases = (
            ("press", {"keys": ["Down"], "delay": True}),
            ("press", {"keys": ["Down"], "delay": -1}),
            ("enter_text", {"text": "x", "delay": "1"}),
            ("collect_logs", {"seconds": float("inf")}),
            ("run_flow", {"scenario": "/x", "evidence_dir": "/y", "dry_run": "true"}),
        )
        for name, arguments in cases:
            with self.subTest(name=name), self.assertRaises(ValueError):
                server.call_tool(name, arguments)

    def test_cancellation_marks_queued_and_terminates_running_requests(self):
        process = object()
        server.IN_FLIGHT[7] = process
        with mock.patch.object(server, "terminate_process") as terminate:
            server.cancel_request(7)
            terminate.assert_called_once_with(process)
        server.PENDING_REQUESTS.add(8)
        server.cancel_request(8)
        self.assertIn(8, server.CANCELLED_REQUESTS)
        token = server.CURRENT_REQUEST_ID.set(8)
        try:
            with self.assertRaises(server.RequestCancelled):
                server.execute(["must-not-run"])
        finally:
            server.CURRENT_REQUEST_ID.reset(token)

    def test_windows_termination_uses_bounded_process_tree_kill(self):
        process = mock.Mock(pid=1234)
        process.poll.side_effect = [None, 0]
        with mock.patch.object(server.os, "name", "nt"), mock.patch.object(
            server.subprocess, "run"
        ) as run:
            server.terminate_process(process)
        run.assert_called_once_with(
            ["taskkill", "/PID", "1234", "/T", "/F"],
            check=False,
            stdout=server.subprocess.DEVNULL,
            stderr=server.subprocess.DEVNULL,
            timeout=server.WINDOWS_TERMINATION_TIMEOUT,
        )
        process.terminate.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows process-tree behavior")
    def test_windows_termination_stops_descendant_process(self):
        child_code = "import time; time.sleep(60)"
        parent_code = (
            "import subprocess,sys,time; "
            f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
            "print(child.pid, flush=True); time.sleep(60)"
        )
        parent = subprocess.Popen(
            [sys.executable, "-c", parent_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(
            subprocess.run,
            ["taskkill", "/PID", str(parent.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        self.assertIsNotNone(parent.stdout)
        pid_output = queue.Queue()
        reader = threading.Thread(
            target=lambda: pid_output.put(parent.stdout.readline()),
            daemon=True,
        )
        reader.start()
        try:
            child_pid = int(
                pid_output.get(timeout=server.WINDOWS_TERMINATION_TIMEOUT).strip()
            )
        except queue.Empty:
            server.terminate_process(parent)
            self.fail("Timed out waiting for the Windows child-process PID.")
        self.addCleanup(
            subprocess.run,
            ["taskkill", "/PID", str(child_pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

        server.terminate_process(parent)
        parent.wait(timeout=server.WINDOWS_TERMINATION_TIMEOUT)
        deadline = time.monotonic() + 5
        while True:
            listing = subprocess.run(
                ["tasklist", "/FI", f"PID eq {child_pid}", "/FO", "CSV", "/NH"],
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
            if f'"{child_pid}"' not in listing.stdout or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        self.assertNotIn(f'"{child_pid}"', listing.stdout)

    def test_concurrent_duplicate_request_id_has_one_owner(self):
        barrier = threading.Barrier(8)
        results = []
        result_lock = threading.Lock()

        def reserve():
            barrier.wait()
            acquired = server.reserve_request_id("same-id")
            with result_lock:
                results.append(acquired)

        workers = [threading.Thread(target=reserve) for _ in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(False), 7)
        self.assertIn("same-id", server.PENDING_REQUESTS)

    def test_cancelled_request_id_cannot_be_reused_until_cleanup(self):
        self.assertTrue(server.reserve_request_id(42))
        server.cancel_request(42)
        self.assertIn(42, server.CANCELLED_REQUESTS)
        self.assertFalse(server.reserve_request_id(42))

        server.release_request_id(42)

        self.assertNotIn(42, server.CANCELLED_REQUESTS)
        self.assertTrue(server.reserve_request_id(42))

    def test_in_flight_request_id_is_rejected_even_without_pending_marker(self):
        server.IN_FLIGHT[7] = object()
        self.assertFalse(server.reserve_request_id(7))

    def test_same_device_aliases_serialize_mutations(self):
        active = 0
        maximum = 0
        guard = threading.Lock()

        def call(_name, _arguments):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.03)
            with guard:
                active -= 1
            return {"command_succeeded": True, "stdout": "", "stderr": ""}

        address = [(server.socket.AF_INET, server.socket.SOCK_STREAM, 6, "", ("192.168.1.2", 0))]
        with mock.patch.object(server, "resolve_target", side_effect=lambda value=None: value or "roku.local"), \
             mock.patch.object(server.socket, "getaddrinfo", return_value=address), \
             mock.patch.object(server, "call_tool", side_effect=call):
            workers = [threading.Thread(target=server.tool_result, args=("press", {"host": host, "keys": ["Down"]}))
                       for host in ("roku.local", "192.168.1.2")]
            for worker in workers: worker.start()
            for worker in workers: worker.join()
        self.assertEqual(maximum, 1)

    def test_flow_timeout_accounts_for_pause_keys_and_screenshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            scenario = Path(temporary) / "flow.json"
            scenario.write_text(json.dumps({"steps": [
                {"action": "pause", "seconds": 3600},
                {"action": "press", "keys": ["Down"] * 40, "delay": 10},
                {"action": "screenshot", "save": "screen.jpg"},
            ]}))
            self.assertGreaterEqual(server.flow_timeout(scenario, False), 4970)

    @unittest.skipIf(os.name == "nt", "symlink behavior is platform/privilege dependent on Windows")
    def test_explicit_artifact_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_text("safe")
            link = root / "capture.log"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                server.path_arg(str(link), "output")


if __name__ == "__main__":
    unittest.main()
