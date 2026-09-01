import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLOW = ROOT / "plugins/roku-device-toolkit/skills/roku-flow-verifier/scripts/run_flow.py"
DEVICE = ROOT / "plugins/roku-device-toolkit/skills/roku-device-operator/scripts/roku_device.py"
REPORT_SCHEMA = ROOT / "plugins/roku-device-toolkit/skills/roku-flow-verifier/references/flow-report.schema.json"
SCHEMA_VALIDATOR = ROOT / "tests/node/schema-validator.mjs"


class FlowCliTests(unittest.TestCase):
    def copy_plugin_runtime(self, destination):
        source_plugin = ROOT / "plugins/roku-device-toolkit"
        shutil.copytree(source_plugin / "scripts", destination / "scripts")
        shutil.copytree(source_plugin / "skills", destination / "skills")

    def run_flow(
        self,
        scenario,
        evidence,
        scenario_filename="scenario.json",
        device_override=True,
        flow=FLOW,
    ):
        scenario_path = evidence.parent / scenario_filename
        scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
        env = dict(os.environ)
        if device_override:
            env["ROKU_DEVICE_TOOL"] = str(DEVICE)
        else:
            env.pop("ROKU_DEVICE_TOOL", None)
        completed = subprocess.run(
            [sys.executable, str(flow), "--scenario", str(scenario_path), "--evidence-dir", str(evidence),
             "--host", "127.0.0.1", "--dry-run"],
            text=True, capture_output=True, env=env, timeout=20,
        )
        report_path = evidence / "report.json"
        return completed, json.loads(report_path.read_text()) if report_path.exists() else None

    def test_versioned_plugin_cache_resolves_sibling_device_tool(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = Path(temporary) / "plugins/cache/roku-device-toolkit/0.2.1"
            self.copy_plugin_runtime(cache_root)
            flow = cache_root / "skills/roku-flow-verifier/scripts/run_flow.py"

            completed, report = self.run_flow(
                {"steps": [{"action": "query", "kind": "active-app", "contains": "dev"}]},
                Path(temporary) / "evidence",
                device_override=False,
                flow=flow,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIsNotNone(report)

    def test_standalone_skill_install_resolves_sibling_device_tool(self):
        with tempfile.TemporaryDirectory() as temporary:
            standalone_root = Path(temporary) / ".codex"
            self.copy_plugin_runtime(standalone_root)
            flow = standalone_root / "skills/roku-flow-verifier/scripts/run_flow.py"

            completed, report = self.run_flow(
                {"steps": [{"action": "query", "kind": "info", "contains": "model"}]},
                Path(temporary) / "evidence",
                device_override=False,
                flow=flow,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIsNotNone(report)

    def test_missing_device_tool_reports_every_searched_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache_root = Path(temporary) / "plugins/cache/roku-device-toolkit/0.2.1"
            physical_flow = cache_root / "skills/roku-flow-verifier/scripts/run_flow.py"
            physical_flow.parent.mkdir(parents=True)
            shutil.copy2(FLOW, physical_flow)
            shutil.copytree(ROOT / "plugins/roku-device-toolkit/scripts", cache_root / "scripts")
            linked_flow = Path(temporary) / ".codex/skills/roku-flow-verifier/scripts/run_flow.py"
            linked_flow.parent.mkdir(parents=True)
            linked_flow.symlink_to(physical_flow)
            missing_override = Path(temporary) / "explicit/missing-device.py"
            scenario = {"steps": [{"action": "query", "kind": "info", "contains": "model"}]}
            scenario_path = Path(temporary) / "scenario.json"
            scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
            env = {
                **os.environ,
                "ROKU_DEVICE_TOOL": str(missing_override),
                "ROKU_DEV_PASSWORD": "must-not-appear",
            }

            completed = subprocess.run(
                [sys.executable, str(linked_flow), "--scenario", str(scenario_path),
                 "--evidence-dir", str(Path(temporary) / "evidence"), "--host", "127.0.0.1",
                 "--dry-run"],
                text=True, capture_output=True, env=env, timeout=20,
            )

            physical_sibling = cache_root / "skills/roku-device-operator/scripts/roku_device.py"
            linked_sibling = Path(temporary) / ".codex/skills/roku-device-operator/scripts/roku_device.py"
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(str(missing_override), completed.stderr)
            self.assertIn(str(physical_sibling), completed.stderr)
            self.assertIn(str(linked_sibling), completed.stderr)
            self.assertNotIn("must-not-appear", completed.stderr)

    def assert_report_schema(self, report_path):
        validation = subprocess.run(
            ["node", str(SCHEMA_VALIDATOR), str(REPORT_SCHEMA), str(report_path)],
            text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(validation.returncode, 0, validation.stderr)

    def test_dry_run_never_claims_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            completed, report = self.run_flow(
                {"steps": [{"action": "query", "kind": "active-app", "contains": "dev"}]},
                Path(temporary) / "evidence",
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertFalse(report["verified"])
            self.assertFalse(report["passed"])
            self.assertEqual(report["steps"][0]["status"], "skipped")
            self.assert_report_schema(Path(temporary) / "evidence" / "report.json")

    def test_preflight_reports_every_invalid_step_before_actions(self):
        with tempfile.TemporaryDirectory() as temporary:
            completed, report = self.run_flow(
                {"steps": [{"action": "press", "keys": [None]}, None,
                           {"action": "launch", "channel_id": None}, {"action": 123}]},
                Path(temporary) / "evidence",
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(len(report["steps"]), 4)
            self.assertTrue(all(step["status"] == "invalid" for step in report["steps"]))
            self.assertIsNone(report["steps"][3]["action"])
            self.assert_report_schema(Path(temporary) / "evidence" / "report.json")

    def test_unknown_fields_and_non_boolean_continuation_are_rejected(self):
        cases = (
            {"unknown": True, "steps": [{"action": "screenshot", "save": "screen.jpg"}]},
            {"continue_on_failure": "false", "steps": [{"action": "screenshot", "save": "screen.jpg"}]},
            {"name": 1, "steps": [{"action": "screenshot", "save": "screen.jpg"}]},
            {"steps": [{"action": "launch", "channel_id": "dev", "contentID": "x"}]},
        )
        for index, scenario in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temporary:
                completed, _ = self.run_flow(scenario, Path(temporary) / "evidence")
                self.assertNotEqual(completed.returncode, 0)

    def test_omitted_name_rejects_blank_filename_stem(self):
        with tempfile.TemporaryDirectory() as temporary:
            completed, report = self.run_flow(
                {"steps": [{"action": "screenshot", "save": "screen.jpg"}]},
                Path(temporary) / "evidence",
                " .json",
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIsNone(report)
            self.assertIn("filename stem must be non-empty", completed.stderr)

    def test_artifact_escape_duplicate_and_reserved_report_are_rejected(self):
        cases = (
            {"steps": [{"action": "screenshot", "save": "../escape.jpg"}]},
            {"steps": [{"action": "query", "kind": "apps", "save": "same.txt"},
                       {"action": "query", "kind": "active-app", "save": "./same.txt"}]},
            {"steps": [{"action": "query", "kind": "apps", "save": "nested/same.txt"},
                       {"action": "query", "kind": "active-app", "save": "nested\\same.txt"}]},
            {"steps": [{"action": "query", "kind": "apps", "save": "report.json"}]},
        )
        for index, scenario in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temporary:
                completed, report = self.run_flow(scenario, Path(temporary) / "evidence")
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(report["passed"])

    def test_report_and_evidence_directory_are_private_on_posix(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary) / "evidence"
            completed, _ = self.run_flow(
                {"steps": [{"action": "screenshot", "save": "screen.jpg"}]}, evidence,
            )
            self.assertEqual(completed.returncode, 0)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE((evidence / "report.json").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
