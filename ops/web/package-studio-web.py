#!/usr/bin/env python3
"""Builds the CloudBase upload package for apps/web.

A hand-assembled archive once shipped without its Dockerfile and the deploy
failed with nothing but "no Dockerfile in the package", so the manifest is
explicit here and every entry is asserted to exist before anything is written.

Usage: python ops/web/package-studio-web.py <release-tag>
"""
import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps/web"
MARKER = "public/deployment-version.json"

TREES = ["app", "components", "lib", "public"]
FILES = ["Dockerfile", "Dockerfile.payment-smoke", ".dockerignore", ".env.example",
         "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts"]


def main(tag):
    out = ROOT / f"petpack-studio-web-{tag}.zip"
    members = []
    for tree in TREES:
        base = WEB / tree
        if not base.is_dir():
            raise SystemExit(f"missing tree: {tree}")
        members += [p.relative_to(WEB).as_posix() for p in sorted(base.rglob("*")) if p.is_file()]
    for name in FILES:
        if not (WEB / name).is_file():
            raise SystemExit(f"missing file: {name}")

    ordered = sorted(members) + FILES
    # The marker carries the digest, so it cannot be part of what is digested.
    digest = hashlib.sha256()
    for name in ordered:
        if name == MARKER:
            continue
        digest.update(name.encode())
        digest.update((WEB / name).read_bytes())

    git = lambda *args: subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()
    version = json.loads((WEB / MARKER).read_text(encoding="utf-8"))
    version["createdAt"] = subprocess.check_output(
        ["git", "-C", str(ROOT), "show", "-s", "--format=%cd",
         "--date=format-local:%Y-%m-%dT%H:%M:%S.0000000Z", "HEAD"],
        text=True, env={**os.environ, "TZ": "UTC"}).strip()
    version["gitCommit"] = git("rev-parse", "HEAD")
    version["sourceSha256"] = digest.hexdigest()
    (WEB / MARKER).write_text(json.dumps(version, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ordered:
            archive.write(WEB / name, name)

    print(f"{out.name}  {len(ordered)} entries  {round(out.stat().st_size / 1024)} KB")
    print(f"commit {version['gitCommit'][:12]}  sha256 {version['sourceSha256'][:16]}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
