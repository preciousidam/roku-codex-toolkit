#!/usr/bin/env python3
"""Atomic, private artifact replacement for Roku toolkit outputs."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from typing import IO, Optional


def _identity(status: os.stat_result) -> tuple[int, int]:
    return status.st_dev, status.st_ino


class AtomicArtifact:
    """Stage an artifact privately and replace a pinned destination on commit."""

    def __init__(
        self,
        destination: Path,
        label: str = "Artifact",
        allowed_root: Optional[Path] = None,
    ) -> None:
        requested = Path(destination).expanduser()
        try:
            parent = requested.parent.resolve(strict=True)
        except OSError as error:
            raise ValueError(f"{label} directory does not exist: {requested.parent}") from error
        if not parent.is_dir():
            raise ValueError(f"{label} parent must be a directory: {parent}")
        if allowed_root is not None:
            try:
                root = Path(allowed_root).expanduser().resolve(strict=True)
                parent.relative_to(root)
            except (OSError, ValueError) as error:
                raise ValueError(
                    f"{label} directory escapes the allowed root: {requested.parent}"
                ) from error
        self.destination = parent / requested.name
        if not requested.name or requested.name in {".", ".."}:
            raise ValueError(f"{label} must resolve to a file: {requested}")
        self._validate_destination(label)
        self._label = label
        self._parent_identity = _identity(parent.stat())
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.destination.name}.", dir=parent
        )
        self._descriptor: Optional[int] = descriptor
        self.temporary = Path(temporary_name)
        os.chmod(self.temporary, 0o600)
        self._temporary_identity = _identity(os.fstat(descriptor))
        self._committed = False

    def _validate_destination(self, label: Optional[str] = None) -> None:
        name = label or self._label
        if self.destination.is_symlink():
            raise ValueError(f"{name} must not be a symlink: {self.destination}")
        if self.destination.exists() and not self.destination.is_file():
            raise ValueError(f"{name} must resolve to a regular file: {self.destination}")

    def _close_descriptor(self) -> None:
        if self._descriptor is not None:
            os.close(self._descriptor)
            self._descriptor = None

    def open_text(self) -> IO[str]:
        if self._descriptor is None:
            raise RuntimeError("Artifact staging descriptor is already closed.")
        descriptor = self._descriptor
        self._descriptor = None
        return os.fdopen(descriptor, "w", encoding="utf-8")

    def open_binary(self) -> IO[bytes]:
        if self._descriptor is None:
            raise RuntimeError("Artifact staging descriptor is already closed.")
        descriptor = self._descriptor
        self._descriptor = None
        return os.fdopen(descriptor, "wb")

    def close_for_external_writer(self) -> Path:
        self._close_descriptor()
        return self.temporary

    def commit(self) -> Path:
        self._close_descriptor()
        try:
            current_parent = self.destination.parent.resolve(strict=True)
        except OSError as error:
            raise RuntimeError(
                f"{self._label} directory changed before commit: {self.destination.parent}"
            ) from error
        if current_parent != self.destination.parent or _identity(current_parent.stat()) != self._parent_identity:
            raise RuntimeError(
                f"{self._label} directory changed before commit: {self.destination.parent}"
            )
        self._validate_destination()
        temporary_status = self.temporary.lstat()
        if not stat.S_ISREG(temporary_status.st_mode) or _identity(temporary_status) != self._temporary_identity:
            raise RuntimeError(f"{self._label} staging file changed before commit.")
        os.chmod(self.temporary, 0o600)
        os.replace(self.temporary, self.destination)
        self._committed = True
        return self.destination

    def cleanup(self) -> None:
        self._close_descriptor()
        if not self._committed:
            self.temporary.unlink(missing_ok=True)

    def __enter__(self) -> "AtomicArtifact":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.cleanup()


def write_private_text(
    path: Path,
    value: str,
    label: str = "Artifact",
    allowed_root: Optional[Path] = None,
) -> Path:
    with AtomicArtifact(path, label, allowed_root) as artifact:
        with artifact.open_text() as handle:
            handle.write(value)
        return artifact.commit()
