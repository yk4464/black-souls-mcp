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


def extract_entry(archive: Path, wanted_name: str) -> tuple[str, bytes]:
    archive_size = archive.stat().st_size
    normalized_wanted = wanted_name.replace("/", "\\").casefold()
    with archive.open("rb") as stream:
        if read_exact(stream, len(MAGIC)) != MAGIC:
            raise ValueError("Archive is not an RGSSAD v3 file")
        initial_key = struct.unpack("<I", read_exact(stream, 4))[0]
        metadata_key = (initial_key * 9 + 3) & 0xFFFFFFFF
        match: tuple[str, int, int, int] | None = None
        while True:
            encrypted = struct.unpack("<4I", read_exact(stream, 16))
            offset, size, file_key, name_length = (value ^ metadata_key for value in encrypted)
            if offset == 0:
                break
            if name_length <= 0 or name_length > 32768:
                raise ValueError(f"Invalid filename length: {name_length}")
            name = decrypt_filename(read_exact(stream, name_length), metadata_key)
            if offset < 0 or size < 0 or offset + size > archive_size:
                raise ValueError(f"Invalid entry bounds for {name!r}")
            if name.replace("/", "\\").casefold() == normalized_wanted:
                if match is not None:
                    raise ValueError(f"Archive contains duplicate entry {wanted_name!r}")
                match = (name, offset, size, file_key)
        if match is None:
            raise FileNotFoundError(f"Archive entry not found: {wanted_name}")
        name, offset, size, file_key = match
        stream.seek(offset)
        return name, decrypt_file(read_exact(stream, size), file_key)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract one file from an RGSSAD v3 archive")
    parser.add_argument("archive", type=Path)
    parser.add_argument("entry")
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-archive-sha256")
    parser.add_argument("--expected-output-sha256")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    archive = args.archive.resolve()
    output = args.output.resolve()
    if output.exists() and not args.force:
        raise FileExistsError(f"Output already exists: {output}")
    if args.expected_archive_sha256:
        actual_archive_hash = sha256(archive)
        if actual_archive_hash != args.expected_archive_sha256.upper():
            raise ValueError(
                f"Archive SHA256 mismatch: expected {args.expected_archive_sha256.upper()}, "
                f"found {actual_archive_hash}"
            )

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
