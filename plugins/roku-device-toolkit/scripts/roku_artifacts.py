#!/usr/bin/env python3
"""Atomic, private artifact replacement for Roku toolkit outputs."""

from __future__ import annotations

import os
import secrets
import stat
import tempfile
from pathlib import Path
from typing import IO, Optional


def _identity(status: os.stat_result) -> tuple[int, int]:
    return status.st_dev, status.st_ino


def _open_parent_anchor(parent: Path) -> int:
    if os.name != "nt":
        access_mode = getattr(os, "O_PATH", None)
        if access_mode is None:
            access_mode = getattr(os, "O_SEARCH", os.O_RDONLY)
        flags = (
            access_mode
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        return os.open(parent, flags)

    import ctypes
    from ctypes import wintypes

    create_file = ctypes.windll.kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    handle = create_file(
        str(parent),
        0,
        0x00000001 | 0x00000002,  # Share reads and writes, but not delete/rename.
        None,
        3,  # OPEN_EXISTING
        0x02000000,  # FILE_FLAG_BACKUP_SEMANTICS permits opening a directory.
        None,
    )
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError()
    return int(handle)


def _close_parent_anchor(anchor: int) -> None:
    if os.name != "nt":
        os.close(anchor)
        return

    import ctypes
    from ctypes import wintypes

    close_handle = ctypes.windll.kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    if not close_handle(anchor):
        raise ctypes.WinError()


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
        self._parent_anchor: Optional[int] = _open_parent_anchor(parent)
        try:
            if (
                os.name != "nt"
                and _identity(os.fstat(self._parent_anchor)) != self._parent_identity
            ):
                raise RuntimeError(
                    f"{label} directory changed during setup: {requested.parent}"
                )
            current_parent = requested.parent.resolve(strict=True)
            if (
                current_parent != parent
                or _identity(current_parent.stat()) != self._parent_identity
            ):
                raise RuntimeError(
                    f"{label} directory changed during setup: {requested.parent}"
                )
            descriptor, temporary_name = self._create_staging_file(parent)
        except Exception:
            self._close_parent_anchor()
            raise
        self._descriptor: Optional[int] = descriptor
        self.temporary = Path(temporary_name)
        os.chmod(self.temporary, 0o600)
        self._temporary_identity = _identity(os.fstat(descriptor))
        self._committed = False

    def _create_staging_file(self, parent: Path) -> tuple[int, str]:
        if os.name == "nt":
            return tempfile.mkstemp(prefix=f".{self.destination.name}.", dir=parent)
        if self._parent_anchor is None:
            raise RuntimeError("Artifact directory anchor is unavailable.")
        for _attempt in range(100):
            name = f".{self.destination.name}.{secrets.token_hex(8)}"
            try:
                descriptor = os.open(
                    name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=self._parent_anchor,
                )
                return descriptor, str(parent / name)
            except FileExistsError:
                continue
        raise FileExistsError(f"Unable to allocate staging file in {parent}")

    def _validate_destination(self, label: Optional[str] = None) -> None:
        name = label or self._label
        if os.name != "nt" and getattr(self, "_parent_anchor", None) is not None:
            try:
                status = os.stat(
                    self.destination.name,
                    dir_fd=self._parent_anchor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                return
            if stat.S_ISLNK(status.st_mode):
                raise ValueError(f"{name} must not be a symlink: {self.destination}")
            if not stat.S_ISREG(status.st_mode):
                raise ValueError(
                    f"{name} must resolve to a regular file: {self.destination}"
                )
            return
        if self.destination.is_symlink():
            raise ValueError(f"{name} must not be a symlink: {self.destination}")
        if self.destination.exists() and not self.destination.is_file():
            raise ValueError(f"{name} must resolve to a regular file: {self.destination}")

    def _close_descriptor(self) -> None:
        if self._descriptor is not None:
            os.close(self._descriptor)
            self._descriptor = None

    def _close_parent_anchor(self) -> None:
        if self._parent_anchor is not None:
            anchor = self._parent_anchor
            self._parent_anchor = None
            _close_parent_anchor(anchor)

    def open_text(self) -> IO[str]:
        if self._descriptor is None:
            raise RuntimeError("Artifact staging descriptor is already closed.")
        return os.fdopen(os.dup(self._descriptor), "w", encoding="utf-8")

    def open_binary(self) -> IO[bytes]:
        if self._descriptor is None:
            raise RuntimeError("Artifact staging descriptor is already closed.")
        return os.fdopen(os.dup(self._descriptor), "wb")

    def path_for_external_writer(self) -> Path:
        return self.temporary

    def commit(self) -> Path:
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
        if self._descriptor is None or self._parent_anchor is None:
            raise RuntimeError(f"{self._label} staging descriptor closed before commit.")
        temporary_status = (
            self.temporary.lstat()
            if os.name == "nt"
            else os.stat(
                self.temporary.name,
                dir_fd=self._parent_anchor,
                follow_symlinks=False,
            )
        )
        open_status = os.fstat(self._descriptor)
        if (
            not stat.S_ISREG(temporary_status.st_mode)
            or _identity(temporary_status) != _identity(open_status)
            or _identity(open_status) != self._temporary_identity
        ):
            raise RuntimeError(f"{self._label} staging file changed before commit.")
        if hasattr(os, "fchmod"):
            os.fchmod(self._descriptor, 0o600)
        else:
            os.chmod(self.temporary, 0o600)
        self._close_descriptor()
        if os.name == "nt":
            os.replace(self.temporary, self.destination)
        else:
            os.replace(
                self.temporary.name,
                self.destination.name,
                src_dir_fd=self._parent_anchor,
                dst_dir_fd=self._parent_anchor,
            )
        self._committed = True
        self._close_parent_anchor()
        return self.destination

    def cleanup(self) -> None:
        self._close_descriptor()
        if not self._committed:
            if os.name == "nt" or self._parent_anchor is None:
                self.temporary.unlink(missing_ok=True)
            else:
                try:
                    os.unlink(self.temporary.name, dir_fd=self._parent_anchor)
                except FileNotFoundError:
                    pass
        self._close_parent_anchor()

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
