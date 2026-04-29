# Skeleton ticket format

Read this when filing a new skeleton. Not auto-loaded — referenced from
`skeletons.md`.

- **Tags:** `skeleton`
- **Type:** `chore`
- **Priority:** 4 (the trigger, not priority, decides when to act)
- **Title:** lead with the limitation, not the proposed solution
- **Body:** must begin with a single-line `Scope:` line, then four sections:

```
Scope: <files, globs, or module names — comma-separated, ONE LINE>

## Shortcut
What we did instead, with file paths.

## Why
The cost/scope reason we deferred the proper fix.

## Proper fix
What the better approach looks like, 1–3 sentences.

## Trigger
The concrete signal that should make us graduate from the shortcut.
```

The `Scope:` line must be a single line — `tk skeletons-for` parses it
line-by-line. If the scope wraps across multiple lines, the skeleton
becomes invisible to the pre-edit scan.

## Scope entries

Each comma-separated entry can be:

- An exact file path: `src/auth/login.py`
- A directory: `src/auth/` (matches anything inside)
- A glob: `src/auth/*.py` (matches via fnmatch)
- A path component / module name: `auth` (matches any path containing
  `auth` as a directory component)
