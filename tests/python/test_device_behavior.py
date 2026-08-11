import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "plugins/roku-device-toolkit/skills/roku-device-operator/scripts/roku_device.py"
SPEC = importlib.util.spec_from_file_location("roku_device_behavior", PATH)
device = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(device)


class DeviceBehaviorTests(unittest.TestCase):
    def test_curl_credentials_use_stdin_not_argv(self):
        completed = mock.Mock(returncode=0, stdout="ok", stderr="")
        with mock.patch.object(device, "trusted_developer_host", return_value="192.168.1.2"), \
             mock.patch.object(device, "require_password", return_value='secret"value'), \
             mock.patch.object(device.subprocess, "run", return_value=completed) as run:
            device.curl_digest("roku.local", "/plugin_inspect", [])
        command = run.call_args.args[0]
        self.assertNotIn("secret", " ".join(command))
        self.assertIn("--noproxy", command)
        self.assertIn("--max-time", command)
        self.assertIn("secret", run.call_args.kwargs["input"])

    def test_screenshot_validates_signature_and_preserves_prior_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "screen.jpg"
            output.write_bytes(b"prior")

            def valid(_host, _path, _extra, destination=None):
                if destination:
                    Path(destination).write_bytes(b"\xff\xd8\xffjpeg")
                return ""

            with mock.patch.object(device, "curl_digest", side_effect=valid):
                device.take_screenshot("roku", output)
            self.assertEqual(output.read_bytes(), b"\xff\xd8\xffjpeg")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

            def invalid(_host, _path, _extra, destination=None):
                if destination:
                    Path(destination).write_bytes(b"<html>error</html>")
                return ""

            with mock.patch.object(device, "curl_digest", side_effect=invalid), self.assertRaises(SystemExit):
                device.take_screenshot("roku", output)
            self.assertEqual(output.read_bytes(), b"\xff\xd8\xffjpeg")

    def test_sideload_requires_confirmation_and_success_response(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "app.zip"
            archive.write_bytes(b"zip")
            with self.assertRaises(SystemExit):
                device.sideload("roku", archive, False)
            with mock.patch.object(device, "curl_digest", return_value="Install Failure"), self.assertRaises(SystemExit):
                device.sideload("roku", archive, True)
            with mock.patch.object(device, "curl_digest", return_value="Install Success"):
                device.sideload("roku", archive, True)

    def test_log_capture_preserves_partial_and_prior_artifacts(self):
        class Connection:
            def __init__(self, values): self.values = iter(values)
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def setblocking(self, _value): return None
            def recv(self, _size): return next(self.values)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            partial = root / "partial.log"
            connection = Connection((b"partial", b""))
            with mock.patch.object(device.socket, "create_connection", return_value=connection), \
                 mock.patch.object(device.select, "select", side_effect=lambda *_args: ([connection], [], [])), \
                 mock.patch.object(device.time, "monotonic", return_value=0.0), \
                 self.assertRaises(SystemExit):
                device.collect_logs("roku", 10, partial)
            self.assertEqual(partial.read_bytes(), b"partial")

            prior = root / "prior.log"
            prior.write_text("prior")
            empty = Connection((b"",))
            with mock.patch.object(device.socket, "create_connection", return_value=empty), \
                 mock.patch.object(device.select, "select", return_value=([empty], [], [])), \
                 mock.patch.object(device.time, "monotonic", return_value=0.0), \
                 self.assertRaises(SystemExit):
                device.collect_logs("roku", 10, prior)
            self.assertEqual(prior.read_text(), "prior")


if __name__ == "__main__":
    unittest.main()
