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
    matches = [entry for entry in objects if len(entry) == 3 and str(entry[1]) == args.title]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one {args.title!r} script, found {len(matches)}")

    if args.backup and not args.backup.exists():
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, args.backup)

    matches[0][2] = zlib.compress(source, 9)
    encoded = writes(objects)
    temp = archive.with_suffix(archive.suffix + ".tmp")
    temp.write_bytes(encoded)

    verification = loads(temp.read_bytes())
    checked = [entry for entry in verification if len(entry) == 3 and str(entry[1]) == args.title]
    if len(checked) != 1 or zlib.decompress(checked[0][2]) != source:
        temp.unlink(missing_ok=True)
        raise RuntimeError("Round-trip verification failed")

    os.replace(temp, archive)
    print(f"patched={archive}")
    print(f"title={args.title}")
    print(f"source_bytes={len(source)}")
    print(f"archive_bytes={len(encoded)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
