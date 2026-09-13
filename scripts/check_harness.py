#!/usr/bin/env python3
"""Validate the initial repo context; no application tests are implied."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "README.md", "AGENTS.md", "CLAUDE.md", "docs/product.md",
    "docs/state.md", "docs/workflow.md", "docs/decisions.md",
    "docs/task-template.md",
)


def main():
    errors = []
    for name in REQUIRED:
        path = ROOT / name
        if not path.is_file() or not path.read_text(encoding="utf-8").strip():
            errors.append(f"Missing or empty context file: {name}")
            continue
        # Check simple inline local links in the foundation documents.
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
            if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
                continue
            relative = target.split("#", 1)[0]
            if relative and not (path.parent / relative).exists():
                errors.append(f"Broken local link in {name}: {target}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"PASS: {len(REQUIRED)} context files and their local links.")
    print("Scope: harness foundation only; no application tests exist yet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
