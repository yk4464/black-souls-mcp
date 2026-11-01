from __future__ import annotations

import argparse
import hashlib
import os
import struct
from pathlib import Path


MAGIC = b"RGSSAD\x00\x03"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def read_exact(stream, size: int) -> bytes:
    value = stream.read(size)
    if len(value) != size:
        raise ValueError("Unexpected end of RGSS3A archive")
    return value


def decrypt_filename(value: bytes, key: int) -> str:
    key_bytes = struct.pack("<I", key)
    decoded = bytes(byte ^ key_bytes[index % 4] for index, byte in enumerate(value))
    return decoded.decode("utf-8")


def decrypt_file(value: bytes, key: int) -> bytes:
    result = bytearray(len(value))
    current = key
    for index, byte in enumerate(value):
        if index and index % 4 == 0:
            current = (current * 7 + 3) & 0xFFFFFFFF
        result[index] = byte ^ ((current >> ((index % 4) * 8)) & 0xFF)
    return bytes(result)


def archive_entries(stream, archive_size: int):
    if read_exact(stream, len(MAGIC)) != MAGIC:
        raise ValueError("Archive is not an RGSSAD v3 file")
    initial_key = struct.unpack("<I", read_exact(stream, 4))[0]
    metadata_key = (initial_key * 9 + 3) & 0xFFFFFFFF
    while True:
        encrypted = struct.unpack("<4I", read_exact(stream, 16))
        offset, size, file_key, name_length = (value ^ metadata_key for value in encrypted)
        if offset == 0:
            return
        if name_length <= 0 or name_length > 32768:
            raise ValueError(f"Invalid filename length: {name_length}")
        name = decrypt_filename(read_exact(stream, name_length), metadata_key)
        if offset + size > archive_size:
            raise ValueError(f"Invalid entry bounds for {name!r}")
        yield name, offset, size, file_key


def extract_entry(archive: Path, wanted_name: str) -> tuple[str, bytes]:
    normalized_wanted = wanted_name.replace("/", "\\").casefold()
    with archive.open("rb") as stream:
        match: tuple[str, int, int, int] | None = None
        for entry in archive_entries(stream, archive.stat().st_size):
            name = entry[0]
            if name.replace("/", "\\").casefold() == normalized_wanted:
                if match is not None:
                    raise ValueError(f"Archive contains duplicate entry {wanted_name!r}")
                match = entry
        if match is None:
            raise FileNotFoundError(f"Archive entry not found: {wanted_name}")
        name, offset, size, file_key = match
        stream.seek(offset)
        return name, decrypt_file(read_exact(stream, size), file_key)


def extract_all(archive: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    different: list[str] = []
    count = written = 0
    with archive.open("rb") as stream:
        for name, offset, size, file_key in archive_entries(stream, archive.stat().st_size):
            normalized = name.replace("\\", "/")
            relative = Path(normalized)
            if not relative.parts or relative.is_absolute() or ":" in relative.parts[0] or any(part in ("", ".", "..") for part in normalized.split("/")):
                raise ValueError(f"Unsafe archive entry path: {name!r}")
            identity = normalized.casefold()
            if identity in seen:
                raise ValueError(f"Archive contains duplicate entry: {name!r}")
            seen.add(identity)
            target = (output_dir / relative).resolve()
            if not target.is_relative_to(output_dir):
                raise ValueError(f"Archive entry escapes output directory: {name!r}")
            metadata_position = stream.tell()
            stream.seek(offset)
            data = decrypt_file(read_exact(stream, size), file_key)
            stream.seek(metadata_position)
            count += 1
            if target.exists() and target.read_bytes() == data:
                continue
            if target.exists():
                different.append(normalized)
                print(f"different_loose_file={normalized}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(target.name + f".tmp.{os.getpid()}")
            temp.write_bytes(data)
            os.replace(temp, target)
            written += 1
    print(f"archive={archive}")
    print(f"output_directory={output_dir}")
    print(f"entries={count}")
    print(f"written={written}")
    print(f"different_loose_files={len(different)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract one file or all files from an RGSSAD v3 archive")
    parser.add_argument("archive", type=Path)
    parser.add_argument("entry", nargs="?", help="Entry name, or output directory with --all")
    parser.add_argument("output", nargs="?", type=Path)
    parser.add_argument("--all", action="store_true", help="Extract every entry, replacing different loose files")
    parser.add_argument("--expected-archive-sha256")
    parser.add_argument("--expected-output-sha256")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    archive = args.archive.resolve()
    if args.all:
        if not args.entry or args.output or args.expected_output_sha256:
            parser.error("--all requires one output directory and does not accept --expected-output-sha256")
    elif not args.entry or not args.output:
        parser.error("single-file extraction requires ENTRY and OUTPUT")
    if args.expected_archive_sha256:
        actual_archive_hash = sha256(archive)
        if actual_archive_hash != args.expected_archive_sha256.upper():
            raise ValueError(
                f"Archive SHA256 mismatch: expected {args.expected_archive_sha256.upper()}, "
                f"found {actual_archive_hash}"
            )

    if args.all:
        extract_all(archive, Path(args.entry).resolve())
        return 0

    output = args.output.resolve()
    if output.exists() and not args.force:
        raise FileExistsError(f"Output already exists: {output}")
    actual_name, data = extract_entry(archive, args.entry)
    output_hash = hashlib.sha256(data).hexdigest().upper()
    if args.expected_output_sha256 and output_hash != args.expected_output_sha256.upper():
        raise ValueError(
            f"Output SHA256 mismatch: expected {args.expected_output_sha256.upper()}, found {output_hash}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + f".tmp.{os.getpid()}")
    temp.write_bytes(data)
    os.replace(temp, output)
    print(f"archive={archive}")
    print(f"entry={actual_name}")
    print(f"output={output}")
    print(f"bytes={len(data)}")
    print(f"sha256={output_hash}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
