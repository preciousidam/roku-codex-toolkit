import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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

    @unittest.skipIf(os.name == "nt", "POSIX directory permission behavior")
    @unittest.skipUnless(
        hasattr(os, "O_PATH") or hasattr(os, "O_SEARCH"),
        "Platform has no search-only directory-open mode",
    )
    def test_write_search_only_directory_does_not_require_read_permission(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "drop"
            parent.mkdir(mode=0o300)
            destination = parent / "capture.log"
            try:
                artifacts.write_private_text(destination, "safe")
                self.assertEqual(destination.read_text(encoding="utf-8"), "safe")
            finally:
                parent.chmod(0o700)

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

    @unittest.skipIf(os.name == "nt", "POSIX directory-descriptor identity test")
    def test_substituted_parent_anchor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requested = root / "requested"
            substitute = root / "substitute"
            requested.mkdir()
            substitute.mkdir()
            substitute_anchor = artifacts._open_parent_anchor(substitute)

            with mock.patch.object(
                artifacts,
                "_open_parent_anchor",
                return_value=substitute_anchor,
            ):
                with self.assertRaisesRegex(RuntimeError, "directory changed during setup"):
                    artifacts.AtomicArtifact(requested / "capture.log")

            with self.assertRaises(OSError):
                os.fstat(substitute_anchor)
            self.assertEqual(list(substitute.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "POSIX descriptor-relative replacement test")
    def test_parent_swap_during_replace_stays_in_anchored_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requested = root / "requested"
            outside = root / "outside"
            moved = root / "moved"
            requested.mkdir()
            outside.mkdir()
            artifact = artifacts.AtomicArtifact(requested / "capture.log")
            with artifact.open_text() as handle:
                handle.write("safe")
            real_replace = os.replace

            def swap_then_replace(source, destination, **kwargs):
                requested.rename(moved)
                requested.symlink_to(outside, target_is_directory=True)
                return real_replace(source, destination, **kwargs)

            try:
                with mock.patch.object(artifacts.os, "replace", side_effect=swap_then_replace):
                    artifact.commit()
                self.assertEqual((moved / "capture.log").read_text(), "safe")
                self.assertFalse((outside / "capture.log").exists())
            finally:
                artifact.cleanup()

    @unittest.skipUnless(os.name == "nt", "Windows directory-handle behavior")
    def test_windows_parent_cannot_be_renamed_during_artifact_lifecycle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requested = root / "requested"
            requested.mkdir()
            artifact = artifacts.AtomicArtifact(requested / "capture.log")
            try:
                with self.assertRaises(OSError):
                    requested.rename(root / "moved")
            finally:
                artifact.cleanup()
            requested.rename(root / "moved")

    @unittest.skipIf(os.name == "nt", "unlinking an open staged file is not supported on Windows")
    def test_staging_file_swap_before_commit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "capture.log"
            artifact = artifacts.AtomicArtifact(destination)
            staged = artifact.path_for_external_writer()
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
