import importlib.util
import ast
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


config = load("roku_config_test", "plugins/roku-device-toolkit/scripts/roku_config.py")
device = load("roku_device_test", "plugins/roku-device-toolkit/skills/roku-device-operator/scripts/roku_device.py")
flow = load("roku_flow_test", "plugins/roku-device-toolkit/skills/roku-flow-verifier/scripts/run_flow.py")
analyzer = load("roku_log_test", "plugins/roku-engineering/skills/roku-runtime-log-analyzer/scripts/analyze_roku_log.py")
server = load("roku_server_test", "plugins/roku-device-toolkit/mcp/server.py")


class ConfigurationTests(unittest.TestCase):
    def test_target_rejects_urls_and_ports(self):
        for value in ("", "http://roku", "roku:8060", "user@roku"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                config.validate_target(value)

    def test_save_target_is_private_and_atomic(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "private" / "config.json"
            with mock.patch.dict(os.environ, {config.CONFIG_ENV: str(path)}):
                config.save_target("192.168.1.20")
            self.assertEqual(json.loads(path.read_text())["target"], "192.168.1.20")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    def test_custom_existing_parent_permissions_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "shared"
            parent.mkdir(mode=0o755)
            path = parent / "config.json"
            before = stat.S_IMODE(parent.stat().st_mode)
            with mock.patch.dict(os.environ, {config.CONFIG_ENV: str(path)}):
                config.save_target("192.168.1.20")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(parent.stat().st_mode), before)

    def test_existing_default_directory_is_hardened(self):
        if os.name != "posix":
            self.skipTest("POSIX mode assertion")
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "default"
            parent.mkdir(mode=0o755)
            with mock.patch.object(config, "DEFAULT_CONFIG", parent / "config.json"), \
                 mock.patch.dict(os.environ, {}, clear=True):
                config.save_target("192.168.1.20")
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o700)

    @unittest.skipIf(os.name == "nt", "symlink behavior is platform/privilege dependent on Windows")
    def test_symlinked_config_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir()
            link = root / "link"
            link.symlink_to(target, target_is_directory=True)
            with mock.patch.dict(os.environ, {config.CONFIG_ENV: str(link / "config.json")}), \
                 self.assertRaises(RuntimeError):
                config.save_target("192.168.1.20")

    def test_unavailable_filesystem_anchor_is_rejected(self):
        path = Path("/unavailable/roku/config")
        with mock.patch.object(Path, "exists", return_value=False), \
             self.assertRaisesRegex(RuntimeError, "existing parent"):
            config.ensure_private_directory(path)


class RepositoryTests(unittest.TestCase):
    def test_all_python_sources_parse(self):
        for path in (ROOT / "plugins").rglob("*.py"):
            with self.subTest(path=path):
                ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


class DeviceTests(unittest.TestCase):
    def test_developer_auth_is_lan_only(self):
        self.assertEqual(device.trusted_developer_host("192.168.1.20"), "192.168.1.20")
        with self.assertRaises(SystemExit):
            device.trusted_developer_host("8.8.8.8")

    def test_xml_root_is_verified(self):
        self.assertIn("device-info", device.pretty_xml(b"<device-info/>", "device-info"))
        with self.assertRaises(SystemExit):
            device.pretty_xml(b"<html/>", "device-info")


class FlowTests(unittest.TestCase):
    def test_artifacts_cannot_escape_or_replace_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("../escape.log", "report.json", "REPORT.JSON"):
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    flow.safe_artifact(root, relative)

    def test_screenshot_is_not_automatic_verification(self):
        self.assertFalse(flow.is_verification_checkpoint({"action": "screenshot", "save": "screen.jpg"}))
        self.assertTrue(flow.is_verification_checkpoint({"action": "query", "kind": "player", "contains": "play"}))


class AnalyzerTests(unittest.TestCase):
    def test_sensitive_values_are_redacted(self):
        line = "authorization=Bearer secret access_token=abc@example.com"
        redacted = analyzer.redact(line)
        self.assertNotIn("secret", redacted)
        self.assertNotIn("abc@example.com", redacted)


class ServerTests(unittest.TestCase):
    def test_tool_inventory_and_annotations(self):
        self.assertEqual(len(server.TOOLS), 13)
        tools = {tool["name"]: tool for tool in server.TOOLS}
        for name in ("take_screenshot", "collect_logs", "run_flow"):
            self.assertTrue(tools[name]["annotations"]["destructiveHint"])

    def test_invalid_ids_and_unknown_arguments_are_rejected(self):
        response = server.handle({"jsonrpc": "2.0", "id": True, "method": "ping"})
        self.assertEqual(response["error"]["code"], -32600)
        result = server.tool_result("press", {"keys": ["Down"], "hosst": "roku"})
        self.assertTrue(result["isError"])


if __name__ == "__main__":
    unittest.main()
