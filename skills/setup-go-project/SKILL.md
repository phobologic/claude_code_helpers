---
name: setup-go-project
description: Scaffold a new Go project with a Makefile, golangci-lint, GitHub Actions CI, and two-layer git hooks (pre-commit + pre-push). Use when the user says "set up a new Go project", "scaffold a Go project", "create a new Go CLI", or similar.
argument-hint: "[project-name]"
---

# Setup Go Project

Scaffold a new Go project with opinionated defaults: a `cmd/<name>/main.go` layout,
a Makefile with `build`/`test`/`lint`/`fmt`/`clean`/`cover` targets, `golangci-lint`
for linting, GitHub Actions for CI, and a two-layer git-hook setup — fast gate at
pre-commit (goimports + `go vet`) and full gate at pre-push (`make lint && make test`,
mirroring CI).

## Phase 1 — Determine project name and module path

- If `$ARGUMENTS` is non-empty, use it as the project name
- Otherwise, infer from `basename $PWD`
- Ask the user for the Go **module path** (e.g. `github.com/<user>/<name>`). Do not
  guess — wrong module paths are painful to change later. If `go.mod` already exists,
  read the module path from it instead of asking.

Present a brief summary, then ask for confirmation. If `.git/` exists, include the
hook files in the list; otherwise omit them and note that hooks will be skipped
until git is initialized.

For new projects:

```
Project name:    <name>
Module path:     <module-path>
Binary:          <name> (in cmd/<name>/)
Files to create: go.mod, Makefile, .gitignore, README.md, .golangci.yml,
                 cmd/<name>/main.go, .github/workflows/ci.yml
Git hooks:       .git/hooks/pre-commit, .git/hooks/pre-commit.d/go.sh,
                 .git/hooks/pre-push,   .git/hooks/pre-push.d/go.sh
                 (or: "skipped — git not initialized")

Proceed? [y/N]
```

For existing projects (re-run), show what will be added/updated:

```
Project name:    <name> (existing project)

Updates:
  .golangci.yml:           add <missing linters>
  Makefile:                add <missing targets>
  .github/workflows/ci.yml: already up to date
  pre-push.d/go.sh:        add (hook is new)

Proceed? [y/N]
```

## Phase 2 — Preflight checks

Before writing anything:

1. Check which target files already exist. Read each existing file so you understand
   what's already configured.
2. Check if git is initialized (`git rev-parse --git-dir 2>/dev/null`). If not, note it
   in the final report — don't run `git init` yourself.
3. Check if `go` and `golangci-lint` are on PATH. If `golangci-lint` is missing, note
   the install command (`brew install golangci-lint` or
   `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest`) in the
   final report.

**Incremental updates.** This skill can be re-run on existing projects to bring them up
to date. For each file below:
- **Missing:** create it exactly as specified.
- **Exists:** read it, compare against the spec, and add only what's missing. Do not
  overwrite user customizations (custom linters, modified thresholds, additional Makefile
  targets). For config files like `.golangci.yml`, add missing linters without touching
  existing ones. For shell scripts like pre-commit hooks, add missing check blocks
  without rewriting existing ones.

If an existing setting directly contradicts the spec (e.g. the user has a different
`local-prefixes` for goimports, or a conflicting linter disabled), do not silently
overwrite it — ask the user how they want to handle the conflict.

Present a summary of what will be created vs. updated, then ask for confirmation.

## Phase 3 — Scaffold files

For each file: create if missing, or update if it exists (see Phase 2).

### `go.mod`

Run `go mod init <module-path>` rather than writing this file by hand. This ensures
the correct default Go version is recorded.

### `Makefile`

```makefile
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X main.version=$(VERSION)
BINARY  := <name>

.PHONY: build test lint fmt clean cover install

build:
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/$(BINARY)

install:
	go install -ldflags "$(LDFLAGS)" ./cmd/$(BINARY)

test:
	go test -race ./...

lint:
	golangci-lint run ./...

fmt:
	goimports -w .

clean:
	rm -f $(BINARY) coverage.out coverage.html

cover:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
```

### `.golangci.yml`

`local-prefixes` should be set to the module path.

```yaml
version: "2"

linters:
  enable:
    - errcheck
    - govet
    - staticcheck
    - ineffassign
    - misspell
    - unconvert
    - gocritic

formatters:
  enable:
    - goimports
  settings:
    goimports:
      local-prefixes:
        - <module-path>

issues:
  max-issues-per-linter: 0
  max-same-issues: 0
```

### `.gitignore`

```
# Binary
/<name>

# Test & coverage
coverage.out
coverage.html

# Editor / OS
.DS_Store
*.swp

# Claude Code scratch
.code-review/
.tickets/
.worktrees/
.tmp/
```

### `README.md`

```markdown
# <name>
```

### `cmd/<name>/main.go`

```go
package main

import "fmt"

// version is injected at build time via -ldflags "-X main.version=..."
var version = "dev"

func main() {
	fmt.Printf("<name> %s\n", version)
}
```

### `.github/workflows/ci.yml`

Pin action SHAs — renovate/dependabot can bump them later, but pinned SHAs prevent
supply-chain surprises.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

      - uses: actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5.6.0
        with:
          go-version-file: go.mod

      - name: Build
        run: go build ./...

      - name: Test
        run: go test -race ./...

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

      - uses: actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5.6.0
        with:
          go-version-file: go.mod

      - uses: golangci/golangci-lint-action@1e7e51e771db61008b38414a730f564565cf7c20 # v9.2.0
        with:
          version: v2.10.1
```

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

### `.git/hooks/pre-commit.d/go.sh`

Only create this if `.git/` exists.

Fast gate: fix formatting with `goimports`, re-stage, then `go vet` on the changed
packages. Full lint and tests live at pre-push.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Get staged .go files (excluding deleted files)
STAGED_GO=$(git diff --cached --name-only --diff-filter=d | grep '\.go$' || true)

if [[ -z "$STAGED_GO" ]]; then
  exit 0
fi

# Format what we can, then re-stage the fixes
if command -v goimports >/dev/null 2>&1; then
  echo "$STAGED_GO" | xargs goimports -w
else
  echo "$STAGED_GO" | xargs gofmt -w
fi
echo "$STAGED_GO" | xargs git add

# Check pass — fail if anything remains unformatted (shouldn't happen after fix above)
if command -v goimports >/dev/null 2>&1; then
  UNFORMATTED=$(echo "$STAGED_GO" | xargs goimports -l)
else
  UNFORMATTED=$(echo "$STAGED_GO" | xargs gofmt -l)
fi
if [[ -n "$UNFORMATTED" ]]; then
  echo ""
  echo "pre-commit: formatter left unformatted files (this shouldn't happen — file a bug):"
  echo "$UNFORMATTED"
  exit 1
fi

# Vet the packages containing the staged files. Dedup directories.
PKG_DIRS=$(echo "$STAGED_GO" | xargs -n1 dirname | sort -u | sed 's|^|./|')
# shellcheck disable=SC2086
if ! go vet $PKG_DIRS 2>&1; then
  echo ""
  echo "pre-commit: go vet failed. Fix the issues above and retry."
  exit 1
fi
```

### `.git/hooks/pre-push`

Only create this if `.git/` exists. If it already exists, leave it alone. Same
dispatcher shape as pre-commit — a language-agnostic runner for `pre-push.d/`.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Dispatcher: runs all scripts in pre-push.d/, fails if any fail.
HOOK_DIR="$(dirname "$0")/pre-push.d"

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

### `.git/hooks/pre-push.d/go.sh`

Only create this if `.git/` exists.

Full gate: runs exactly what CI runs. Exits cleanly if this isn't a Go project
(e.g. polyglot repo where Go was removed).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Skip if this isn't a Go project anymore
if [[ ! -f go.mod ]]; then
  exit 0
fi

# Skip if there are no Go files (edge case)
if ! find . -name '*.go' -not -path './.git/*' -not -path './vendor/*' -print -quit | grep -q .; then
  exit 0
fi

echo "pre-push: running make lint..."
if ! make lint; then
  echo ""
  echo "pre-push: make lint failed. Fix the issues above, or bypass with --no-verify if you have a reason."
  exit 1
fi

echo "pre-push: running make test..."
if ! make test; then
  echo ""
  echo "pre-push: make test failed. Fix the failures above, or bypass with --no-verify if you have a reason."
  exit 1
fi
```

## Phase 4 — Install

Run these commands in sequence, narrating each step:

```bash
go mod init <module-path>    # only if go.mod does not already exist
go mod tidy
```

After `go mod tidy`, make the git hooks executable (only if `.git/` exists):

```bash
chmod +x .git/hooks/pre-commit .git/hooks/pre-commit.d/go.sh \
         .git/hooks/pre-push   .git/hooks/pre-push.d/go.sh
```

## Phase 5 — Commit

If `.git/` exists, commit all scaffolded files:

1. Stage all new files created in Phases 2–4 (go.mod, go.sum, Makefile, config files,
   workflow, source files). Do **not** stage files inside `.git/` (hooks are not
   tracked by git).
2. Commit with message: `Add Go project scaffold`

If `.git/` does not exist, skip this phase — the Report will tell the user to
`git init` and commit manually.

## Phase 6 — Report

Print a summary of what was created. Then suggest next steps:

1. If git was not initialized: `git init && git add -A && git commit -m "Initial project scaffold"`,
   then re-run `/setup-go-project` to install the hooks (they require `.git/`).
2. If git was initialized, note that **two** hooks were installed:
   - **pre-commit** — fast gate: runs `goimports` and `go vet` on staged files on every commit
   - **pre-push** — full gate: runs `make lint && make test` before each push, mirroring CI
   The dispatcher pattern in `.git/hooks/pre-commit` and `.git/hooks/pre-push` supports
   multiple languages — other setup skills can drop scripts in `.git/hooks/pre-commit.d/`
   or `.git/hooks/pre-push.d/`.
3. If `golangci-lint` is not installed, recommend:
   ```
   brew install golangci-lint
   # or: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
   ```
4. To enable Claude's in-session auto-formatting for Go files in this project:
   ```
   /plugin install claude-go@claude-languages
   ```
5. See the Go rules (`~/.claude/rules/go.md`) for coding conventions and preferred patterns.
6. Build and run:
   ```
   make build && ./<name>
   ```
