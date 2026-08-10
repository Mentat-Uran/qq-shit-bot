#!/usr/bin/env python3
"""Audit tracked OpenClaw files for pins, secrets, and runtime leakage."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*[\"']?(?!\$\{|replace-with-|local\b|<)[A-Za-z0-9_+/=.-]{16,}"
)
IMAGE = re.compile(r"(?m)^\s*image:\s*([^\s#]+)")


def tracked_files(root: Path) -> list[Path]:
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root, check=True, capture_output=True)
    return [root / item for item in result.stdout.decode().split("\0") if item]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    findings: list[dict[str, str]] = []
    files = tracked_files(root)
    for path in files:
        relative = path.relative_to(root).as_posix()
        lowered = relative.lower()
        if "/runtime/" in f"/{lowered}" or lowered.endswith(("/.env", ".log", ".db", ".sqlite")):
            findings.append({"kind": "runtime-file-tracked", "file": relative})
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data:
            continue
        text = data.decode("utf-8", errors="replace")
        if PRIVATE_KEY.search(text):
            findings.append({"kind": "private-key", "file": relative})
        if relative != "deploy/openclaw/.env.example" and SECRET_ASSIGNMENT.search(text):
            findings.append({"kind": "secret-like-assignment", "file": relative})

    env_example = root / "deploy/openclaw/.env.example"
    if env_example.exists() and not re.search(r"replace-with-[A-Za-z0-9_-]+", env_example.read_text(encoding="utf-8")):
        findings.append({"kind": "env-example-missing-placeholders", "file": "deploy/openclaw/.env.example"})

    for path in (root / "deploy/openclaw/docker-compose.yml", root / "deploy/openclaw/docker-compose.local.yml"):
        if not path.exists():
            continue
        for image in IMAGE.findall(path.read_text(encoding="utf-8")):
            if ":latest" in image or (":" not in image and "@sha256:" not in image):
                findings.append({"kind": "unpinned-image", "file": path.relative_to(root).as_posix()})

    if env_example.exists() and not re.search(
        r"OPENCLAW_QQBOT_PLUGIN=@openclaw/qqbot@\d+\.\d+\.\d+", env_example.read_text(encoding="utf-8")
    ):
        findings.append({"kind": "unpinned-plugin", "file": "deploy/openclaw/.env.example"})

    requirements = root / "tests/requirements-deploy.txt"
    if requirements.exists():
        for line in requirements.read_text(encoding="utf-8").splitlines():
            if line and not line.lstrip().startswith("#") and "==" not in line:
                findings.append({"kind": "unpinned-test-dependency", "file": "tests/requirements-deploy.txt"})
                break

    for relative in ("LICENSE", "docs/DEPENDENCY_LICENSE_AUDIT.md", "docs/SECURITY_OPERATIONS.md"):
        if not (root / relative).is_file():
            findings.append({"kind": "missing-governance-document", "file": relative})

    report = {"tracked_files": len(files), "findings": findings, "passed": not findings, "secrets_redacted": True}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"Security audit: {'passed' if not findings else 'failed'}; tracked files={len(files)}; findings={len(findings)}; secrets redacted.")
        for finding in findings:
            print(f"{finding['kind']}: {finding['file']}")
    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
