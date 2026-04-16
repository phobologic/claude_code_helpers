---
paths:
  - "**/*.ts"
  - "**/*.js"
  - "**/*.svelte"
---

# JavaScript / TypeScript / SvelteKit Conventions

Reusable JS/TS rules. Include from project-level CLAUDE.md files.

## Code Conventions

**TypeScript** — Strict mode always (`"strict": true` in tsconfig). Use explicit
types for function signatures and exports. Infer types for local variables when
obvious. Prefer `interface` over `type` for object shapes (interfaces are extendable
and produce better error messages). Use `type` for unions, intersections, and mapped
types.

**Imports** — Named imports preferred over default imports. Group order:
svelte/kit > third-party > local (`$lib/`), blank lines between groups.
Use `$lib/` alias for imports from `src/lib/`.

**Naming** — `camelCase` functions/variables, `PascalCase` components and types/interfaces,
`UPPER_SNAKE_CASE` constants. File names: `kebab-case.ts` for modules,
`PascalCase.svelte` for components. SvelteKit route files use `+` prefix
(`+page.svelte`, `+layout.ts`, `+server.ts`).

**Svelte 5 runes** — Use the modern reactivity API:
- `$state()` for reactive state
- `$derived()` for computed values
- `$effect()` for side effects (prefer `$derived` when possible)
- `$props()` for component props
- `$bindable()` for two-way binding props
- `.svelte.ts` extension for files that use runes outside components

**Components** — Keep components focused and small. Extract shared logic into
`.svelte.ts` files. Use `{#snippet}` for reusable template fragments within a
component. Prefer `{#each}` with keyed blocks (`{#each items as item (item.id)}`).

**Error handling** — Use SvelteKit's `error()` and `redirect()` helpers in
load functions and server routes. Handle fetch failures gracefully in the UI.
Never swallow errors silently.

**Paths** — Use `$lib/` for shared code. Use `$app/` for SvelteKit runtime
imports (`$app/navigation`, `$app/stores`, `$app/environment`).

## Package Management (npm)

- `npm install` — install from lockfile
- `npm install <package>` — add a dependency
- `npm install -D <package>` — add a dev dependency
- `npx <command>` — run a locally installed binary

Keep `package-lock.json` committed. Never use `--force` or `--legacy-peer-deps`
unless resolving a genuine conflict.

## Linting & Formatting

**Biome** handles JS/TS files (lint + format in one tool):
- `npx @biomejs/biome check .` — lint + format check
- `npx @biomejs/biome check --write .` — lint-fix + format

**Prettier** handles Svelte files (Biome does not support `.svelte`):
- `npx prettier --check "**/*.svelte"` — check formatting
- `npx prettier --write "**/*.svelte"` — format

**svelte-check** provides type checking for Svelte components:
- `npx svelte-check --tsconfig ./tsconfig.json` — full type check

These run automatically via hooks on file edits, but are available for manual use.

## Testing Conventions

This project uses **Vitest** for testing with `@testing-library/svelte` for
component tests.

- **Invocation strategy** — minimize context usage with tight output by default:
  - **Full suite:** `npx vitest run` — single run, non-watch mode
  - **Specific files:** `npx vitest run path/to/test.ts` — targeted runs
  - **On failure follow-up:** `npx vitest run --reporter=verbose path/to/test.ts`
  - **Watch mode (dev):** `npx vitest` — interactive, re-runs on change
- Co-locate tests with source: `foo.ts` → `foo.test.ts`
- Use `@testing-library/svelte` for component rendering (`render`, `screen`, `fireEvent`)
- Use `jsdom` environment for DOM tests
- Mock fetch/API calls — never hit real endpoints in tests
- Use `vi.mock()` for module mocking, `vi.fn()` for function mocks
- Prefer `getByRole`, `getByText` over `getByTestId` for accessible queries

## Preferred Libraries

When adding a dependency, default to these unless there's a specific reason not to.

**Rendering**
- Markdown: `marked` with `isomorphic-dompurify` for sanitization

**HTTP**
- Fetch API (built-in) for client-side requests
- SvelteKit `fetch` in load functions (handles SSR correctly)

**State**
- Svelte 5 runes (`$state`, `$derived`) for component and shared state
- `.svelte.ts` files for reusable reactive state

**AI**
- Anthropic SDK: `@anthropic-ai/sdk`

**Testing**
- `vitest` — test runner
- `@testing-library/svelte` — component rendering
- `@testing-library/jest-dom` — DOM matchers
- `jsdom` — virtual DOM environment
