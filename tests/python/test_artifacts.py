import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "plugins/roku-device-toolkit/scripts/roku_artifacts.py"
SPEC = importlib.util.spec_from_file_location("roku_artifacts_test", PATH)
artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifacts)


class AtomicArtifactTests(unittest.TestCase):
    def test_replacement_is_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "capture.log"
            destination.write_text("old", encoding="utf-8")

            artifacts.write_private_text(destination, "new")

            self.assertEqual(destination.read_text(encoding="utf-8"), "new")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)

    @unittest.skipIf(os.name == "nt", "symlink creation requires optional Windows privileges")
    def test_existing_destination_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside.log"
            outside.write_text("safe", encoding="utf-8")
            destination = root / "capture.log"
            destination.symlink_to(outside)

            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                artifacts.write_private_text(destination, "unsafe")

            self.assertEqual(outside.read_text(encoding="utf-8"), "safe")

    @unittest.skipIf(os.name == "nt", "symlink creation requires optional Windows privileges")
    def test_destination_symlink_swap_before_commit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside.log"
            outside.write_text("safe", encoding="utf-8")
            destination = root / "capture.log"

            with artifacts.AtomicArtifact(destination) as artifact:
                with artifact.open_text() as handle:
                    handle.write("unsafe")
                destination.symlink_to(outside)
                with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                    artifact.commit()

            self.assertEqual(outside.read_text(encoding="utf-8"), "safe")

    @unittest.skipIf(os.name == "nt", "symlink creation requires optional Windows privileges")
    def test_symlinked_parent_cannot_escape_allowed_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "evidence"
            outside = root / "outside"
            evidence.mkdir()
            outside.mkdir()
            (evidence / "nested").symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "escapes the allowed root"):
                artifacts.write_private_text(
                    evidence / "nested/capture.log",
                    "unsafe",
                    allowed_root=evidence,
                )

            self.assertFalse((outside / "capture.log").exists())

    @unittest.skipIf(os.name == "nt", "directory symlink creation requires optional Windows privileges")
    def test_parent_directory_swap_before_commit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requested = root / "requested"
            outside = root / "outside"
            requested.mkdir()
            outside.mkdir()
            destination = requested / "capture.log"
            artifact = artifacts.AtomicArtifact(destination)
            with artifact.open_text() as handle:
                handle.write("unsafe")
            moved = root / "moved"
            requested.rename(moved)
            requested.symlink_to(outside, target_is_directory=True)
            try:
                with self.assertRaisesRegex(RuntimeError, "directory changed"):
                    artifact.commit()
                self.assertFalse((outside / "capture.log").exists())
            finally:
                artifact.cleanup()

    @unittest.skipIf(os.name == "nt", "unlinking an open staged file is not supported on Windows")
    def test_staging_file_swap_before_commit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "capture.log"
            artifact = artifacts.AtomicArtifact(destination)
            staged = artifact.close_for_external_writer()
            staged.unlink()
            staged.write_text("replacement", encoding="utf-8")
            try:
                with self.assertRaisesRegex(RuntimeError, "staging file changed"):
                    artifact.commit()
                self.assertFalse(destination.exists())
            finally:
                artifact.cleanup()


if __name__ == "__main__":
    unittest.main()
