---
name: setup-js-project
description: Scaffold a new SvelteKit project with Biome, Prettier, Vitest, and GitHub Actions CI. Use when the user says "set up a new JS project", "scaffold a SvelteKit project", "create a new frontend app", or similar.
argument-hint: "[project-name]"
model: sonnet
---

# Setup JavaScript/SvelteKit Project

Scaffold a new SvelteKit project with opinionated defaults: TypeScript strict mode,
Biome for JS/TS linting and formatting, Prettier for Svelte files, Vitest for testing,
and GitHub Actions for CI.

## Phase 1 — Determine project name

- If `$ARGUMENTS` is non-empty, use it as the project name
- Otherwise, infer from `basename $PWD`

Present a brief summary to the user, then ask for confirmation. If `.git/` exists,
include the hook files in the list; otherwise omit them and note that hooks will be
skipped until git is initialized.

For new projects:

```
Project name:    <name>
Framework:       SvelteKit + Svelte 5 + TypeScript
Files to create: package.json, svelte.config.js, vite.config.ts, tsconfig.json,
                 biome.json, .prettierrc, .npmrc, .gitignore, README.md,
                 src/app.html, src/app.d.ts, src/routes/+page.svelte,
                 src/lib/.gitkeep, src/test-setup.ts,
                 .github/workflows/test.yml
Git hooks:       .git/hooks/pre-commit, .git/hooks/pre-commit.d/javascript.sh
                 (or: "skipped — git not initialized")

Proceed? [y/N]
```

For existing projects (re-run), show what will be added/updated:

```
Project name:    <name> (existing project)

Updates:
  biome.json:    add noExcessiveCognitiveComplexity rule
  package.json:  already up to date
  tsconfig.json: already up to date

Proceed? [y/N]
```

## Phase 2 — Preflight checks

Before writing anything:

1. Check which target files already exist. Read each existing file so you understand
   what's already configured.
2. Check if git is initialized (`git rev-parse --git-dir 2>/dev/null`). If not, note it
   in the final report — don't run `git init` yourself.

**Incremental updates.** This skill can be re-run on existing projects to bring them up
to date. For each file below:
- **Missing:** create it exactly as specified.
- **Exists:** read it, compare against the spec, and add only what's missing. Do not
  overwrite user customizations (custom deps, modified biome rules, adjusted thresholds).
  For config files like `biome.json` and `package.json`, add missing sections, rules, and
  dependencies without touching existing ones. For shell scripts like pre-commit hooks,
  add missing check blocks without rewriting existing ones.

If an existing setting directly contradicts the spec (e.g., the user has a different
complexity threshold, or a conflicting biome rule configuration), do not silently
overwrite it — ask the user how they want to handle the conflict.

Present a summary of what will be created vs. updated, then ask for confirmation.

## Phase 3 — Scaffold files

For each file: create if missing, or update if it exists (see Phase 2).

### `package.json`

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check . && prettier --check '**/*.svelte'",
    "format": "biome check --write . && prettier --write '**/*.svelte'"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@sveltejs/adapter-auto": "^6.0.0",
    "@sveltejs/kit": "^2.0.0",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/svelte": "^5.0.0",
    "jsdom": "^25.0.0",
    "prettier": "^3.0.0",
    "prettier-plugin-svelte": "^4.0.0",
    "svelte": "^5.0.0",
    "svelte-check": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

### `svelte.config.js`

```js
import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter()
	},
	preprocess: vitePreprocess()
};

export default config;
```

### `vite.config.ts`

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		setupFiles: ['src/test-setup.ts']
	}
});
```

### `tsconfig.json`

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": {
    "ignore": [
      ".svelte-kit/",
      "build/",
      "node_modules/"
    ]
  },
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noForEach": "off",
        "noExcessiveCognitiveComplexity": {
          "level": "warn",
          "options": {
            "maxAllowedComplexity": 15
          }
        }
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error",
        "useImportType": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always"
    }
  }
}
```

### `.prettierrc`

```json
{
  "useTabs": true,
  "singleQuote": true,
  "trailingComma": "none",
  "printWidth": 100,
  "plugins": ["prettier-plugin-svelte"],
  "overrides": [
    {
      "files": "*.svelte",
      "options": {
        "parser": "svelte"
      }
    }
  ]
}
```

### `.npmrc`

```
engine-strict=true
```

### `.gitignore`

```
node_modules/
.svelte-kit/
build/
dist/
.env
.env.*
!.env.example
.DS_Store
.tmp/
.code-review/
.tickets/
```

### `README.md`

```markdown
# <name>
```

### `src/app.html`

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<link rel="icon" href="%sveltekit.assets%/favicon.png" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
```

### `src/app.d.ts`

```ts
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
```

### `src/routes/+page.svelte`

```svelte
<h1>Welcome to <name></h1>
<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation.</p>
```

### `src/lib/.gitkeep`

Empty file.

### `src/test-setup.ts`

```ts
import '@testing-library/jest-dom/vitest';
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

### `.git/hooks/pre-commit.d/javascript.sh`

Only create this if `.git/` exists.

This hook needs to know where the frontend directory is relative to the repo root,
because `biome`, `prettier`, and `svelte-check` must run from the directory containing
`package.json` and `node_modules`. Detect this at scaffold time: if the current working
directory differs from the git repo root, compute the relative path and embed it in the
hook. If they're the same, the hook runs from the repo root directly.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Frontend directory relative to repo root (empty = repo root)
FRONTEND_DIR="<relative-path-or-empty>"

# Get staged JS/TS/Svelte files (excluding deleted files)
if [[ -n "$FRONTEND_DIR" ]]; then
  STAGED_JS=$(git diff --cached --name-only --diff-filter=d | grep -E "^${FRONTEND_DIR}/.*\.(js|ts|svelte)$" || true)
else
  STAGED_JS=$(git diff --cached --name-only --diff-filter=d | grep -E '\.(js|ts|svelte)$' || true)
fi

if [[ -z "$STAGED_JS" ]]; then
  exit 0
fi

# Split by file type — Biome handles JS/TS, Prettier handles Svelte
STAGED_BIOME=$(echo "$STAGED_JS" | grep -E '\.(js|ts)$' || true)
STAGED_SVELTE=$(echo "$STAGED_JS" | grep -E '\.svelte$' || true)

# Save repo root before cd-ing into the frontend subdir
REPO_ROOT=$(pwd)

# cd to frontend dir for tooling to find config + node_modules
if [[ -n "$FRONTEND_DIR" ]]; then
  cd "$FRONTEND_DIR"
fi

# Strip FRONTEND_DIR prefix so paths are relative to where tools run from.
# Escape glob-special chars (SvelteKit bracket routes like [id]) so tools
# treat them as literal paths.
_rel() {
  if [[ -n "$FRONTEND_DIR" ]]; then
    sed "s|^${FRONTEND_DIR}/||g"
  else
    cat
  fi
}
_esc() { sed 's/\[/\\[/g; s/\]/\\]/g'; }

# Re-stage a list of repo-root-relative paths using :(literal) pathspec magic
# so bracket-style SvelteKit route segments (e.g. [id]) aren't treated as globs.
_restage() {
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    git -C "$REPO_ROOT" add ":(literal)$f"
  done
}

# Fix what we can, then re-stage the fixes
if [[ -n "$STAGED_BIOME" ]]; then
  echo "$STAGED_BIOME" | _rel | _esc | xargs npx @biomejs/biome check --write 2>/dev/null || true
  echo "$STAGED_BIOME" | _restage
fi

if [[ -n "$STAGED_SVELTE" ]]; then
  echo "$STAGED_SVELTE" | _rel | _esc | xargs npx prettier --write --ignore-unknown 2>/dev/null || true
  echo "$STAGED_SVELTE" | _restage
fi

# Check pass — fail the commit if anything remains unfixed
if [[ -n "$STAGED_BIOME" ]]; then
  if ! echo "$STAGED_BIOME" | _rel | _esc | xargs npx @biomejs/biome check 2>&1; then
    echo ""
    echo "pre-commit: biome check failed. Fix the issues above and retry."
    exit 1
  fi
fi

if [[ -n "$STAGED_SVELTE" ]]; then
  if ! echo "$STAGED_SVELTE" | _rel | _esc | xargs npx prettier --check --ignore-unknown 2>&1; then
    echo ""
    echo "pre-commit: prettier check failed (this shouldn't happen — file a bug)."
    exit 1
  fi
fi

# Type check — svelte-check validates both .svelte and .ts files
if ! npx svelte-check --tsconfig ./tsconfig.json 2>&1; then
  echo ""
  echo "pre-commit: svelte-check failed. Fix the type errors above and retry."
  exit 1
fi
```

### `.github/workflows/test.yml`

If a `.github/workflows/test.yml` already exists (e.g., from a Python setup), append a
new job to the existing file rather than overwriting. If creating fresh:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  frontend:
    runs-on: ubuntu-latest

    defaults:
      run:
        working-directory: <working-directory>

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: <working-directory>/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Lint (Biome)
        run: npx @biomejs/biome check .

      - name: Format check (Prettier/Svelte)
        run: npx prettier --check "**/*.svelte"

      - name: Type check
        run: npx svelte-check --tsconfig ./tsconfig.json

      - name: Test
        run: npx vitest run
```

Set `<working-directory>` to the relative path from the repo root if the frontend is in
a subdirectory (e.g., `frontend`). If the frontend is the repo root, use `.` and omit
the `defaults.run.working-directory` block.

> **Note:** If a Python `test.yml` already exists, add the `frontend:` job alongside the
> existing `test:` job. Do not replace it.

## Phase 4 — Install

Run these commands in sequence, narrating each step:

```bash
npm install
```

After install, make the git hooks executable (only if `.git/` exists):

```bash
chmod +x .git/hooks/pre-commit .git/hooks/pre-commit.d/javascript.sh
```

## Phase 5 — Commit

If `.git/` exists, commit all scaffolded files:

1. Stage all new files created in Phases 2–4 (config files, workflows, source files).
   Do **not** stage files inside `.git/` (hooks are not tracked by git).
2. Commit with message: `Add SvelteKit project scaffold`

If `.git/` does not exist, skip this phase — the Report will tell the user to
`git init` and commit manually.

## Phase 6 — Report

Print a summary of what was created. Then suggest next steps:

1. If git was not initialized: `git init && git add -A && git commit -m "Initial project scaffold"`,
   then re-run `/setup-js-project` to install the pre-commit hooks (they require `.git/`).
2. If git was initialized, note that a pre-commit hook was installed that auto-fixes
   formatting, checks Biome + Prettier, and runs svelte-check on every commit. The
   dispatcher pattern in `.git/hooks/pre-commit` supports multiple languages — other
   setup skills can drop scripts in `.git/hooks/pre-commit.d/`.
3. To enable auto-formatting hooks in this project:
   ```
   /plugin install claude-js@claude-languages
   ```
4. See the JS rules (`~/.claude/rules/js.md`) for coding conventions and preferred libraries.
5. Start the dev server with `npm run dev` and visit `http://localhost:5173`.
