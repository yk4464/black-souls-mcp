from __future__ import annotations

import argparse
import os
import shutil
import zlib
from pathlib import Path

try:
    from rubymarshal.reader import loads
    from rubymarshal.writer import writes
except ImportError as error:
    raise SystemExit(
        "Missing optional dependency 'rubymarshal'. "
        "Install it with: python -m pip install -r requirements-tools.txt"
    ) from error


def entry_title(entry) -> str:
    # rubymarshal returns an I-prefixed string as a RubyString object (whose str() is a
    # repr, not the text) and a bare string token as raw bytes; neither survives a
    # plain str() comparison against the title.
    raw = getattr(entry[1], "text", entry[1])
    if isinstance(raw, bytes):
        for encoding in ("utf-8", "cp932", "latin1"):
            try:
                return raw.decode(encoding)
            except UnicodeDecodeError:
                pass
        return ""
    return str(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description="Replace one RGSS3 script in Scripts.rvdata2")
    parser.add_argument("archive", type=Path)
    parser.add_argument("script", type=Path)
    parser.add_argument("--title", default="Main")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()

    archive = args.archive.resolve()
    source = args.script.read_bytes()
    objects = loads(archive.read_bytes())
    matches = [index for index, entry in enumerate(objects) if len(entry) == 3 and entry_title(entry) == args.title]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one {args.title!r} script, found {len(matches)}")
    target_index = matches[0]

    # Every RGSS3 script entry is zlib data. A blob that no longer decompresses means
    # the marshal reader mangled non-UTF-8 bytes while parsing; rewriting the file now
    # would corrupt that entry permanently.
    untouched = [entry[2] for index, entry in enumerate(objects) if len(entry) == 3 and index != target_index]
    untouched_by_index = {index: entry[2] for index, entry in enumerate(objects) if len(entry) == 3 and index != target_index}
    for blob in untouched:
        try:
            zlib.decompress(blob)
        except zlib.error as error:
            raise RuntimeError(
                "A script payload did not survive parsing (non-UTF-8 bytes in the archive); "
                "use patch_rvdata2_binary.py, which patches bytes in place"
            ) from error

    if args.backup and not args.backup.exists():
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, args.backup)

    objects[target_index][2] = zlib.compress(source, 9)
    encoded = writes(objects)
    temp = archive.with_suffix(archive.suffix + ".tmp")
    temp.write_bytes(encoded)

    verification = loads(temp.read_bytes())
    checked = [entry for entry in verification if len(entry) == 3]
    expected = [objects[target_index][2] if index == target_index else untouched_by_index[index] for index in range(len(objects)) if len(objects[index]) == 3]
    if (
        len(checked) != len(objects)
        or zlib.decompress(checked[target_index][2]) != source
        or [entry[2] for entry in checked] != expected
    ):
        temp.unlink(missing_ok=True)
        raise RuntimeError("Round-trip verification failed; the archive was not modified (use patch_rvdata2_binary.py for byte-preserving patching)")

    os.replace(temp, archive)
    print(f"patched={archive}")
    print(f"title={args.title}")
    print(f"source_bytes={len(source)}")
    print(f"archive_bytes={len(encoded)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
