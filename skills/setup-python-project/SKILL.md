---
name: setup-python-project
description: Scaffold a new Python project with uv, ruff, pytest, and GitHub Actions CI. Use when the user says "set up a new Python project", "scaffold a project", "create a new Python app", or similar.
argument-hint: "[project-name]"
---

# Setup Python Project

Scaffold a new Python project with opinionated defaults: uv for package management,
ruff for linting/formatting, pytest for testing, and GitHub Actions for CI.

## Phase 1 — Determine project name

- If `$ARGUMENTS` is non-empty, use it as the project name
- Otherwise, infer from `basename $PWD`
- Derive the Python package name by replacing hyphens with underscores (e.g. `my-app` → `my_app`)

Present a brief summary to the user of what will be created, then ask for confirmation.
If `.git/` exists, include the hook files in the list; otherwise omit them and note that
hooks will be skipped until git is initialized.

```
Project name:    <name>
Package dir:     <package_name>/
Tests dir:       tests/
Files to create: pyproject.toml, .python-version, .gitignore, README.md,
                 <package_name>/__init__.py, tests/__init__.py,
                 .github/workflows/test.yml
Git hooks:       .git/hooks/pre-commit, .git/hooks/pre-commit.d/python.sh
                 (or: "skipped — git not initialized")

Proceed? [y/N]
```

## Phase 2 — Preflight checks

Before writing anything:

1. Check if any of the target files already exist. If conflicts exist, list them and ask
   whether to overwrite. Do not overwrite silently.
2. Check if git is initialized (`git rev-parse --git-dir 2>/dev/null`). If not, note it
   in the final report — don't run `git init` yourself.

## Phase 3 — Scaffold files

Write each file in order:

### `pyproject.toml`

```toml
[project]
name = "<name>"
version = "0.1.0"
description = ""
readme = "README.md"
requires-python = ">=3.13"
dependencies = []

[dependency-groups]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "pytest-cov>=7.1.0",
    "ruff>=0.9.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.coverage.run]
source = ["<package_name>"]

[tool.coverage.report]
show_missing = true
skip_empty = true

[tool.ruff]
target-version = "py313"
line-length = 88

[tool.ruff.lint]
select = [
    "F",    # pyflakes
    "E",    # pycodestyle errors
    "W",    # pycodestyle warnings
    "I",    # isort
    "UP",   # pyupgrade
    "B",    # flake8-bugbear
    "SIM",  # flake8-simplify
    "C4",   # flake8-comprehensions
    "RUF",  # ruff-specific rules
]

[tool.ruff.lint.per-file-ignores]
"tests/*" = ["S101"]

[tool.ruff.lint.isort]
required-imports = ["from __future__ import annotations"]
known-first-party = ["<package_name>"]

[tool.ruff.format]
quote-style = "double"
```

### `.python-version`

```
3.13
```

### `.gitignore`

```
__pycache__/
*.py[cod]
*.egg-info/
dist/
build/
.venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
tmp/
.code-review/
.tickets/
```

### `README.md`

```markdown
# <name>
```

### `<package_name>/__init__.py`

```python
"""<name>."""
```

### `tests/__init__.py`

Empty file.

### `.git/hooks/pre-commit`

Only create this if `.git/` exists. If it already exists, leave it alone (the dispatcher
is language-agnostic and may have been installed by another setup skill).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Dispatcher: runs all scripts in pre-commit.d/, fails if any fail.
HOOK_DIR="$(dirname "$0")/pre-commit.d"

if [[ ! -d "$HOOK_DIR" ]]; then
  exit 0
fi

exit_code=0
for hook in "$HOOK_DIR"/*; do
  if [[ -x "$hook" ]]; then
    if ! "$hook"; then
      exit_code=1
    fi
  fi
done

exit $exit_code
```

### `.git/hooks/pre-commit.d/python.sh`

Only create this if `.git/` exists.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Get staged .py files (excluding deleted files)
STAGED_PY=$(git diff --cached --name-only --diff-filter=d | grep '\.py$' || true)

if [[ -z "$STAGED_PY" ]]; then
  exit 0
fi

# Fix what we can, then re-stage the fixes
echo "$STAGED_PY" | xargs uv run ruff check --fix --unfixable F401 || true
echo "$STAGED_PY" | xargs uv run ruff format
echo "$STAGED_PY" | xargs git add

# Now check — fail the commit if anything unfixable remains
if ! echo "$STAGED_PY" | xargs uv run ruff check 2>&1; then
  echo ""
  echo "pre-commit: ruff check failed. Fix the issues above and retry."
  exit 1
fi

if ! echo "$STAGED_PY" | xargs uv run ruff format --check 2>&1; then
  echo ""
  echo "pre-commit: ruff format failed (this shouldn't happen — file a bug)."
  exit 1
fi
```

### `.github/workflows/test.yml`

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v4
        with:
          enable-cache: true

      - name: Set up Python
        run: uv python install

      - name: Install dependencies
        run: uv sync --frozen

      - name: Lint
        run: uv run ruff check .

      - name: Format check
        run: uv run ruff format --check .

      - name: Test
        run: uv run pytest -q --tb=short --cov=<package_name> --cov-report=term-missing
```

> **Note for published libraries:** Add a `strategy.matrix` with multiple Python versions
> (e.g. 3.11, 3.12, 3.13) and a `publish.yml` workflow for PyPI trusted publishing.

## Phase 4 — Install

Run these commands in sequence, narrating each step:

```bash
uv python pin 3.13
uv sync
```

`uv sync` reads `[dependency-groups]` from `pyproject.toml` and creates the lockfile +
virtual environment in `.venv/`.

After `uv sync`, make the git hooks executable (only if `.git/` exists):

```bash
chmod +x .git/hooks/pre-commit .git/hooks/pre-commit.d/python.sh
```

## Phase 5 — Commit

If `.git/` exists, commit all scaffolded files:

1. Stage all new files created in Phases 2–4 (config files, workflows, source files).
   Do **not** stage files inside `.git/` (hooks are not tracked by git).
2. Commit with message: `Add Python project scaffold`

If `.git/` does not exist, skip this phase — the Report will tell the user to
`git init` and commit manually.

## Phase 6 — Report

Print a summary of what was created. Then suggest next steps:

1. If git was not initialized: `git init && git add -A && git commit -m "Initial project scaffold"`,
   then re-run `/setup-python-project` to install the pre-commit hooks (they require `.git/`).
2. If git was initialized, note that a pre-commit hook was installed that auto-fixes and
   checks ruff on every commit. The dispatcher pattern in `.git/hooks/pre-commit` supports
   multiple languages — other setup skills can drop scripts in `.git/hooks/pre-commit.d/`.
3. To enable auto-formatting hooks in this project:
   ```
   /plugin install claude-python@claude-languages
   ```
4. See the Python rules (`~/.claude/rules/python.md`) for preferred libraries to reach for
   when adding dependencies.
