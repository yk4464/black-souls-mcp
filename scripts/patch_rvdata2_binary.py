from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import struct
import zlib
from pathlib import Path


class MarshalCursor:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.symbols: list[bytes] = []

    def byte(self) -> int:
        value = self.data[self.pos]
        self.pos += 1
        return value

    def long(self) -> int:
        marker = struct.unpack("b", bytes([self.byte()]))[0]
        if marker == 0:
            return 0
        if 5 < marker < 128:
            return marker - 5
        if -129 < marker < -5:
            return marker + 5
        raw = self.data[self.pos : self.pos + abs(marker)]
        self.pos += abs(marker)
        value = int.from_bytes(raw, "little", signed=False)
        if marker < 0:
            value -= 256 ** abs(marker)
        return value

    def blob(self) -> bytes:
        size = self.long()
        value = self.data[self.pos : self.pos + size]
        if len(value) != size:
            raise ValueError("Unexpected end of marshal blob")
        self.pos += size
        return value

    def symbol(self, token: int | None = None) -> bytes:
        token = self.byte() if token is None else token
        if token == ord(":"):
            value = self.blob()
            self.symbols.append(value)
            return value
        if token == ord(";"):
            return self.symbols[self.long()]
        if token == ord("I"):
            value = self.symbol()
            self.attributes()
            return value
        raise ValueError(f"Unexpected symbol token 0x{token:02x} at {self.pos - 1}")

    def attributes(self) -> None:
        for _ in range(self.long()):
            self.symbol()
            self.skip()

    def string(self, token: int | None = None) -> tuple[bytes, int, int, int]:
        token = self.byte() if token is None else token
        if token == ord("I"):
            value, length_pos, data_start, data_end = self.string()
            self.attributes()
            return value, length_pos, data_start, data_end
        if token != ord('"'):
            raise ValueError(f"Expected string token, got 0x{token:02x} at {self.pos - 1}")
        length_pos = self.pos
        size = self.long()
        data_start = self.pos
        value = self.data[self.pos : self.pos + size]
        self.pos += size
        return value, length_pos, data_start, self.pos

    def skip(self) -> None:
        token = self.byte()
        if token in (ord("0"), ord("T"), ord("F")):
            return
        if token == ord("i"):
            self.long(); return
        if token in (ord(":"), ord(";")):
            self.symbol(token); return
        if token in (ord('"'), ord("I")):
            self.string(token); return
        if token == ord("@"):
            self.long(); return
        if token == ord("["):
            for _ in range(self.long()): self.skip()
            return
        raise ValueError(f"Unsupported marshal token 0x{token:02x} at {self.pos - 1}")


def encode_long(value: int) -> bytes:
    if value == 0:
        return b"\x00"
    if 0 < value < 123:
        return bytes([value + 5])
    if value < 0:
        raise ValueError("Negative lengths are unsupported")
    size = max(1, (value.bit_length() + 7) // 8)
    return bytes([size]) + value.to_bytes(size, "little")


def decode_title(raw: bytes) -> str:
    for encoding in ("utf-8", "cp932", "latin1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return ""


def locate_script(data: bytes, title: str) -> tuple[int, int]:
    cursor = MarshalCursor(data)
    if cursor.byte() != 4 or cursor.byte() != 8 or cursor.byte() != ord("["):
        raise ValueError("Not a Ruby Marshal 4.8 script array")
    matches: list[tuple[int, int]] = []
    for _ in range(cursor.long()):
        if cursor.byte() != ord("[") or cursor.long() != 3:
            raise ValueError("Unexpected script entry structure")
        if cursor.byte() != ord("i"):
            raise ValueError("Script id is not a fixnum")
        cursor.long()
        title_bytes, _, _, _ = cursor.string()
        code_token = cursor.byte()
        if code_token == ord("@"):
            cursor.long()
            continue
        code_bytes, length_pos, _, data_end = cursor.string(code_token)
        if decode_title(title_bytes) == title:
            matches.append((length_pos, data_end))
            try:
                zlib.decompress(code_bytes)
            except zlib.error as error:
                raise ValueError(f"Target script payload is not zlib data: {error}") from error
    if len(matches) != 1:
        raise ValueError(f"Expected one {title!r} script, found {len(matches)}")
    return matches[0]


def extract_script(data: bytes, title: str) -> bytes:
    length_pos, _ = locate_script(data, title)
    cursor = MarshalCursor(data)
    cursor.pos = length_pos
    return zlib.decompress(cursor.blob())


def main() -> int:
    parser = argparse.ArgumentParser(description="Byte-preserving RGSS3 script patcher")
    parser.add_argument("archive", type=Path)
    parser.add_argument("script", type=Path)
    parser.add_argument("--title", default="Main")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()

    archive = args.archive.resolve()
    original = archive.read_bytes()
    length_pos, data_end = locate_script(original, args.title)
    source = args.script.read_bytes()
    compressed = zlib.compress(source, 9)
    patched = original[:length_pos] + encode_long(len(compressed)) + compressed + original[data_end:]

    if args.backup and not args.backup.exists():
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, args.backup)
    temp = archive.with_suffix(archive.suffix + ".tmp")
    temp.write_bytes(patched)
    verify_start, verify_end = locate_script(patched, args.title)
    if verify_start <= 0 or verify_end <= verify_start:
        temp.unlink(missing_ok=True)
        raise RuntimeError("Patched archive verification failed")
    if extract_script(patched, args.title) != source:
        temp.unlink(missing_ok=True)
        raise RuntimeError("Patched script content does not match the requested source")
    if patched[:verify_start] != original[:length_pos] or patched[verify_end:] != original[data_end:]:
        temp.unlink(missing_ok=True)
        raise RuntimeError("Bytes outside the target script changed")
    os.replace(temp, archive)
    print(f"patched={archive}")
    print(f"title={args.title}")
    print(f"source_bytes={len(source)}")
    print(f"compressed_bytes={len(compressed)}")
    print(f"archive_bytes={len(patched)}")
    print(f"source_sha256={hashlib.sha256(source).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
