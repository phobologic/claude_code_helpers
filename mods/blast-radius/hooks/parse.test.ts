import { expect, test } from 'claude-code/testing'

import { analyze, analyzeLine, gitRisky, ph } from './parse'

const HOME = ph('HOME')
const only = (command: string) => {
  const effects = analyze(command)
  expect(effects.length).toBe(1)
  return effects[0] as Record<string, unknown>
}

test('commands that change nothing on disk have no effects', () => {
  for (const command of [
    'ls -la && git status && git log --oneline -5',
    'echo "rm -rf / is bad"',
    'git commit -m "rm -rf build; > ~/.zshrc"',
    'echo ok # rm -rf /',
    'grep -rn foo src 2>/dev/null | head',
    'npm test &> /dev/null',
    'make 2>&1 >>build.log',
    'git checkout -b feature/x',
    'git reset --soft HEAD~1',
    'git branch -d done',
    'cp -n a.txt b.txt',
    'ln -s target name',
    'python3 -c "print(1)"',
    'rsync -a src/ host:backup/',
    'tee -a log.txt < input',
    'bash -c "echo $FOO"',
  ]) {
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  }
})

test('rm names its paths, with quoted glob characters made literal', () => {
  expect(only('rm -rf build')).toEqual({ op: 'delete', dir: null, paths: ['build'], recursive: true, cmd: 'rm -rf build' })
  expect(only('rm *.txt "a*.md"')).toMatchObject({ paths: ['*.txt', 'a[*].md'], recursive: false })
  expect(only('rm -- -weird')).toMatchObject({ paths: ['-weird'] })
  expect(only('rm -rf ~/old "$HOME/x"')).toMatchObject({ paths: ['~/old', `${HOME}/x`] })
  expect(only('sudo -u root rm -rf /opt/x')).toMatchObject({ paths: ['/opt/x'] })
  expect(only('timeout 5 \\rm -f x')).toMatchObject({ paths: ['x'] })
  expect(only('/bin/rm -r a')).toMatchObject({ paths: ['a'], recursive: true })
})

test('cd, pushd and subshells move where later paths are measured', () => {
  expect(only('cd /tmp && rm -rf foo')).toMatchObject({ dir: '/tmp' })
  expect(only('cd a; cd b; rm x')).toMatchObject({ dir: 'a/b' })
  expect(analyze('(cd sub && rm x); rm y').map(e => (e as { dir: unknown }).dir)).toEqual(['sub', null])
  expect(only('pushd lib && popd && rm z')).toMatchObject({ dir: null })
  expect(only('env -C /srv rm x')).toMatchObject({ dir: '/srv' })
  expect(only('cd "$(git rev-parse --show-toplevel)" && rm -rf build')).toMatchObject({ dir: ph('BR_TOPLEVEL') })
  expect(only('cd - && rm x')).toMatchObject({ op: 'unknown' })
  expect(only('cd /tmp && rm -rf /abs/path')).toMatchObject({ op: 'delete', dir: '/tmp', paths: ['/abs/path'] })
})

test('a line reports where its top-level cd leaves the shell', () => {
  const end = (command: string) => analyzeLine(command).endDir
  expect(end('ls -la')).toBe(null)
  expect(end('cd /srv/app')).toBe('/srv/app')
  expect(end('cd a && make && cd b')).toBe('a/b')
  expect(end('(cd sub && make)')).toBe(null)
  expect(end('cd x | cat')).toBe(null)
  expect(end('pushd lib && make && popd')).toBe(null)
  expect(end('cd "$WORK"')).toEqual({ unknown: 'cd "$WORK"' })
})

test('variables set on the line, loops and mktemp expand; others are unknown', () => {
  expect(only('D=build; rm -rf "$D/out"')).toMatchObject({ paths: ['build/out'] })
  expect(only('for f in *.tmp; do rm "$f"; done')).toMatchObject({ paths: ['*.tmp'] })
  expect(only('T=$(mktemp -d) && rm -rf "$T"')).toMatchObject({ paths: [`${ph('BR_TMP')}/mktemp`] })
  expect(only('rm -rf "$SOMEDIR"')).toMatchObject({ op: 'unknown' })
  expect(only('rm -rf $(cat list)')).toMatchObject({ op: 'unknown' })
  expect(only('rm -rf "${HOME:-/x}/cache"')).toMatchObject({ paths: [`${HOME}/cache`] })
  expect(only('while read -r f; do rm "$f"; done < list')).toMatchObject({ op: 'unknown' })
})

test('redirects that truncate are overwrites; appends, fds and /dev are not', () => {
  expect(only('echo hi > out.txt 2>&1')).toMatchObject({ op: 'overwrite', paths: ['out.txt'] })
  expect(only('echo hi >| ~/.zshrc')).toMatchObject({ op: 'overwrite', paths: ['~/.zshrc'] })
  expect(only('cmd &> run.log')).toMatchObject({ op: 'overwrite', paths: ['run.log'] })
  expect(only('cmd > "$OUT"')).toMatchObject({ op: 'unknown' })
})

test('heredoc bodies are text, except where a shell or interpreter reads them', () => {
  expect(analyze("cat > notes.md <<'EOF'\nrm -rf /\nEOF")).toEqual([
    { op: 'overwrite', dir: null, paths: ['notes.md'], cmd: "cat > notes.md <<'EOF'" },
  ])
  expect(only("bash <<'EOF'\nrm -rf build\nEOF")).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only("python3 - <<'EOF'\nimport shutil\nshutil.rmtree('x')\nEOF")).toMatchObject({ op: 'unknown' })
  // A heredoc inside $( ) with an apostrophe and parens must not swallow the rest of the line.
  expect(only(`git commit -m "$(cat <<'EOF'\nDon't (do) this\nEOF\n)" && rm -rf build`)).toMatchObject({
    op: 'delete',
    paths: ['build'],
  })
})

test('an unquoted heredoc runs the $( ) and backticks in its body; a quoted one runs nothing', () => {
  const notes = { op: 'overwrite', dir: null, paths: ['notes.md'], cmd: 'cat > notes.md <<EOF' }
  expect(analyze('cat > notes.md <<EOF\nRun `rm -rf build` to clean\nEOF')).toEqual([
    { op: 'delete', dir: null, paths: ['build'], recursive: true, cmd: 'rm -rf build' },
    notes,
  ])
  expect(analyze('cat > notes.md <<EOF\n$(rm -rf ~/x)\nEOF')).toEqual([
    { op: 'delete', dir: null, paths: ['~/x'], recursive: true, cmd: 'rm -rf ~/x' },
    notes,
  ])
  // Only the expansions run, not the body's lines; quotes, escapes and $(( )) hide nothing else.
  expect(analyze('cat > notes.md <<EOF\nrm -rf /\nEOF')).toEqual([notes])
  expect(analyze('cat > notes.md <<EOF\n\\$(rm -rf x) \\`rm -rf y\\` $(( n > 2 ))\nEOF')).toEqual([notes])
  expect(analyze('cat > notes.md <<EOF\nit\'s "$(rm -rf x)"\nEOF')).toEqual([
    { op: 'delete', dir: null, paths: ['x'], recursive: true, cmd: 'rm -rf x' },
    notes,
  ])
  for (const delim of ["'EOF'", '"EOF"', '\\EOF', 'E"OF"']) {
    const command = `cat > notes.md <<${delim}\n$(rm -rf x) \`rm -rf y\`\nEOF`
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [{ ...notes, cmd: `cat > notes.md <<${delim}` }] })
  }
  // Each heredoc on the line goes by its own delimiter.
  expect(analyze("cat <<A <<'B'\n$(rm a)\nA\n$(rm b)\nB")).toEqual([
    { op: 'delete', dir: null, paths: ['a'], recursive: false, cmd: 'rm a' },
  ])
  // A commit message written through an unquoted heredoc inside $( ).
  expect(only('git commit -m "$(cat <<EOF\nFix `rm -rf build`\nEOF\n)"')).toMatchObject({ op: 'delete', paths: ['build'] })
  // A shell reading an unquoted heredoc gets the body with its escapes taken out.
  expect(only('bash <<EOF\necho \\`rm -rf build\\`\nEOF')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(analyze("bash <<'EOF'\necho \\`rm -rf build\\`\nEOF")).toEqual([])
  expect(only('bash <<EOF\nrm -rf \\$HOME/x\nEOF')).toMatchObject({ paths: [`${HOME}/x`] })
  expect(only('bash <<EOF\nrm -rf \\\\$HOME/x\nEOF')).toMatchObject({ paths: [`${HOME}/x`] })
  expect(only('bash <<EOF\necho \\\\`date` > out.txt\nEOF')).toEqual({ op: 'overwrite', dir: null, paths: ['out.txt'], cmd: 'echo `date` > out.txt' })
  expect(only("bash <<EOF\nrm -rf 'a\\\\b' 'bu\\\nild'\nEOF")).toMatchObject({ paths: ['a\\b', 'build'] })
  expect(only("bash <<'EOF'\nrm -rf 'a\\\\b' 'bu\\\nild'\nEOF")).toMatchObject({ paths: ['a\\\\b', 'bu\\\nild'] })
})

test('commands inside $( ), bash -c and eval are read too', () => {
  expect(only('echo $(rm -rf x)')).toMatchObject({ op: 'delete', paths: ['x'] })
  expect(only('cat <<< "$(rm -rf x)"')).toMatchObject({ op: 'delete', paths: ['x'] })
  expect(only("bash -lc 'rm -rf build'")).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('eval "rm -rf build"')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('sh -c "$CMD"')).toMatchObject({ op: 'unknown' })
  expect(only("node -e 'require(\"fs\").rmSync(\"x\", {recursive: true})'")).toMatchObject({ op: 'unknown' })
})

test('find becomes a dry run: deleting actions print, other actions do nothing', () => {
  expect(only("find . -name '*.pyc' -delete")).toEqual({
    op: 'find', dir: null, argv: ['.', '-name', '*.pyc', '-print'], recursive: false, cmd: "find . -name '*.pyc' -delete",
  })
  expect(only('find build -name x -exec rm -rf {} +')).toMatchObject({ argv: ['build', '-name', 'x', '-print'], recursive: true })
  expect(only("find . -name '*.log' -print0 | xargs -0 rm -f")).toMatchObject({
    op: 'find', argv: ['.', '-name', '*.log', '-print'],
  })
  expect(only('find . -type f -exec mv {} /x \\;')).toMatchObject({ op: 'unknown' })
  expect(only('find . -name x -fprint ~/out.txt')).toMatchObject({ op: 'overwrite', paths: ['~/out.txt'] })
  expect(only('ls *.log | xargs rm')).toMatchObject({ op: 'unknown' })
})

test('git commands that can discard work go to the judge; the rest never do', () => {
  expect(only('git checkout -- src/a.ts')).toEqual({ op: 'git', dir: null, argv: ['checkout', '--', 'src/a.ts'], cmd: 'git checkout -- src/a.ts' })
  expect(only('git -C ../other reset --hard')).toMatchObject({ argv: ['-C', '../other', 'reset', '--hard'] })
  expect(only('git clean -fdx')).toMatchObject({ op: 'git' })
  for (const argv of [['status'], ['commit', '-m', 'x'], ['restore', '--staged', 'a'], ['stash'], ['stash', 'pop'], ['clean', '-n'], ['gc'], ['worktree', 'add', 'x']]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: false })
  }
  for (const argv of [['reset', '--hard'], ['restore', 'a'], ['switch', '-f', 'main'], ['stash', 'drop'], ['branch', '-D', 'x'], ['worktree', 'remove', 'w'], ['rm', '-rf', 'x'], ['gc', '--prune=now']]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: true })
  }
})

test('mv, cp, ln -f, tee, dd, curl and rsync name what they overwrite', () => {
  expect(only('mv a.txt ~/Desktop/')).toEqual({
    op: 'copy', dir: null, mode: 'mv', sources: ['a.txt'], dest: ['~/Desktop/'], intoDir: false, noTargetDir: false, noClobber: false, cmd: 'mv a.txt ~/Desktop/',
  })
  expect(only('mv -n a b')).toMatchObject({ mode: 'mv', noClobber: true })
  expect(only('cp -t /opt/x a b')).toMatchObject({ mode: 'cp', sources: ['a', 'b'], dest: ['/opt/x'], intoDir: true })
  expect(only('ln -sf a b')).toMatchObject({ mode: 'ln', noClobber: false })
  expect(only('echo x | tee ~/.zshrc')).toMatchObject({ op: 'overwrite', paths: ['~/.zshrc'] })
  expect(only('dd if=/dev/zero of=disk.img bs=1m count=1')).toMatchObject({ op: 'overwrite', paths: ['disk.img'] })
  expect(only('curl -sSLo ~/bin/tool https://example.com/tool')).toMatchObject({ op: 'overwrite', paths: ['~/bin/tool'] })
  expect(only('rsync -a --delete src/ ~/backup/')).toMatchObject({ op: 'delete', paths: ['~/backup/'], recursive: true })
  expect(only('rsync -a src/ ~/backup/')).toMatchObject({ op: 'overwrite', paths: ['~/backup/'] })
})

test('mv, cp, install and ln each read their own options: -n is no-clobber to mv and cp only', () => {
  const sameAs = (command: string, like: string) =>
    expect({ command, effect: { ...only(command), cmd: '' } }).toEqual({ command, effect: { ...only(like), cmd: '' } })
  const none = (command: string) => expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  const linked = { op: 'copy', dir: null, mode: 'ln', sources: ['x'], dest: ['~/.zshrc'], intoDir: false, noTargetDir: false, noClobber: false }
  expect(only('ln -sf x ~/.zshrc')).toEqual({ ...linked, cmd: 'ln -sf x ~/.zshrc' })
  // ln's -n and -h only stop it following a link to a folder; -f, BSD's -F and -i replace.
  for (const command of ['ln -sfn x ~/.zshrc', 'ln -nsf x ~/.zshrc', 'ln -s -n -f x ~/.zshrc', 'ln -sfh x ~/.zshrc', 'ln -sF x ~/.zshrc', 'ln -si x ~/.zshrc', 'ln -sn --force x ~/.zshrc', 'ln -s --interactive x ~/.zshrc']) {
    sameAs(command, 'ln -sf x ~/.zshrc')
  }
  // Without one ln fails on a destination that exists, and a backup keeps the old file.
  for (const command of ['ln -s x ~/.zshrc', 'ln -sn x ~/.zshrc', 'ln -snh x ~/.zshrc', 'ln -s --no-dereference x ~/.zshrc', 'ln -sbf x ~/.zshrc', 'ln -sf --backup x ~/.zshrc']) {
    none(command)
  }
  // mv and cp keep -n's no-clobber meaning, until a later -f or -i overrides it.
  for (const command of ['mv -n a ~/b', 'mv -fn a ~/b', 'mv -i --no-clobber a ~/b']) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { mode: 'mv', noClobber: true } })
  }
  for (const command of ['mv -nf a ~/b', 'mv -n -i a ~/b', 'mv --no-clobber --force a ~/b']) sameAs(command, 'mv a ~/b')
  for (const command of ['cp -n a ~/b', 'cp -fn a ~/b', 'cp -i --no-clobber a ~/b']) none(command)
  for (const command of ['cp -nf a ~/b', 'cp -ni a ~/b', 'cp --no-clobber --interactive a ~/b']) sameAs(command, 'cp a ~/b')
  expect(only('cp a ~/b')).toMatchObject({ mode: 'cp', sources: ['a'], dest: ['~/b'], noClobber: false })
  // A backup keeps the old file too, but --backup=none and =off make none.
  for (const command of ['cp -b a ~/b', 'cp -fb a ~/b', 'cp --backup a ~/b', 'cp --backup=numbered a ~/b']) none(command)
  expect(only('mv -fb a ~/b')).toMatchObject({ mode: 'mv', noClobber: true })
  for (const command of ['cp --backup=none a ~/b', 'cp --backup=off a ~/b']) sameAs(command, 'cp a ~/b')
  // BSD cp's and install's -S take no value, so the path after one is still a source.
  sameAs('cp -S a ~/b', 'cp a ~/b')
  sameAs('install -S a ~/b', 'install a ~/b')
  expect(only('mv -S .bak a ~/b')).toMatchObject({ sources: ['a'], dest: ['~/b'] })
  expect(only('ln -sfS .bak x ~/.zshrc')).toMatchObject({ sources: ['x'], dest: ['~/.zshrc'] })
  for (const command of ['install -m 644 a ~/b', 'install --mode 644 a ~/b', 'install -o root -g wheel a ~/b']) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { mode: 'cp', sources: ['a'], dest: ['~/b'], noClobber: false } })
  }
  // install -d and --directory make folders and copy nothing.
  for (const command of ['install -d a ~/b', 'install -vd a ~/b', 'install --directory a ~/b']) none(command)
  // Target folders, -T, and `--` that ends the options.
  for (const command of ['cp --target-directory /opt/x a b', 'cp --target-directory=/opt/x a b', 'cp -t/opt/x a b']) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { sources: ['a', 'b'], dest: ['/opt/x'], intoDir: true } })
  }
  for (const command of ['cp -T a ~/b', 'cp --no-target-directory a ~/b', 'ln -sfT x ~/.zshrc']) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { intoDir: false, noTargetDir: true, noClobber: false } })
  }
  expect(only('cp -- -n ~/b')).toMatchObject({ sources: ['-n'], dest: ['~/b'], noClobber: false })
  expect(only('cp - ~/b')).toMatchObject({ sources: ['-'], dest: ['~/b'] })
})
