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
  expect(only('rm --recursive build')).toMatchObject({ op: 'delete', recursive: true })
  expect(only('rm -R build')).toMatchObject({ op: 'delete', recursive: true })
  expect(only('rm -f --verbose build')).toMatchObject({ op: 'delete', recursive: false })
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

test('redirects that truncate are overwrites; appends, fds and /dev/null and kin are not', () => {
  expect(only('echo hi > out.txt 2>&1')).toMatchObject({ op: 'overwrite', paths: ['out.txt'] })
  expect(only('echo hi >| ~/.zshrc')).toMatchObject({ op: 'overwrite', paths: ['~/.zshrc'] })
  expect(only('cmd &> run.log')).toMatchObject({ op: 'overwrite', paths: ['run.log'] })
  expect(only('cmd > "$OUT"')).toMatchObject({ op: 'unknown' })
  expect(only('cat image > /dev/disk2')).toMatchObject({ op: 'overwrite', paths: ['/dev/disk2'] })
  expect(only('cmd > /dev/fd/../disk2')).toMatchObject({ op: 'overwrite', paths: ['/dev/fd/../disk2'] })
  expect(only('cmd > /dev/nullx')).toMatchObject({ op: 'overwrite', paths: ['/dev/nullx'] })
  expect(only('cmd > build/dev/null')).toMatchObject({ op: 'overwrite', paths: ['build/dev/null'] })
})

test('writes to /dev/null, /dev/stdout, /dev/stderr, /dev/tty and /dev/fd/N change nothing', () => {
  for (const sink of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/3']) {
    for (const command of [`cmd > ${sink}`, `cmd >&${sink}`, `echo x | tee ${sink}`, `dd if=/dev/zero of=${sink}`, `curl -o ${sink} https://example.com`]) {
      expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
    }
  }
})

test('a write to any other device is an overwrite, so the judge sees it', () => {
  expect(only('dd if=/dev/zero of=/dev/disk2')).toEqual({
    op: 'overwrite', dir: null, paths: ['/dev/disk2'], cmd: 'dd if=/dev/zero of=/dev/disk2',
  })
  expect(only('echo x | tee /dev/sda')).toMatchObject({ op: 'overwrite', paths: ['/dev/sda'] })
  expect(only('cd /dev && dd if=x of=disk2')).toMatchObject({ op: 'overwrite', dir: '/dev', paths: ['disk2'] })
  // A body that can't be expanded is checked by its text: a sink is harmless, a disk is not.
  expect(analyze('bash -c "echo $X > /dev/null"')).toEqual([])
  expect(analyze('bash -c "echo $X >/dev/stderr; echo $Y"')).toEqual([])
  expect(analyze('bash -c "echo $X > /dev/null && echo $Y"')).toEqual([])
  expect(analyze('eval echo $X \\>/dev/null')).toEqual([])
  expect(only('bash -c "echo $X > /dev/disk2"')).toMatchObject({ op: 'unknown' })
  expect(only('bash -c "echo $X > /dev/null2"')).toMatchObject({ op: 'unknown' })
  expect(analyze('bash -c "x=`cmd $Y 2>/dev/null`"')).toEqual([])
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
  expect(only("python3 -W ignore -c 'import shutil; shutil.rmtree(\"x\")'")).toMatchObject({ op: 'unknown' })
  expect(analyze('python3 -c "print(\'$NAME\')"')).toEqual([])
  // Only deno reads code after `eval`; node runs a script by that name, and a script's
  // stdin is its data.
  expect(analyze("node eval 'require(\"fs\").rmSync(\"x\")'")).toEqual([])
  expect(analyze("python3 tool.py <<'EOF'\nimport shutil; shutil.rmtree('x')\nEOF")).toEqual([])
})

// The effects without their command text, which names the wrapper too.
const bare = (command: string) => analyze(command).map(({ cmd: _cmd, ...effect }) => effect)
const sameAs = (plain: string, wrapped: string[]) => {
  const want = bare(plain)
  expect(want.length).toBe(1)
  for (const command of wrapped) expect({ command, effects: bare(command) }).toEqual({ command, effects: want })
}

test('uv run, poetry run, flock and ionice are judged by the command they run', () => {
  const code = `-c "import shutil; shutil.rmtree('/opt/x')"`
  sameAs(`python ${code}`, [
    `uv run python ${code}`,
    `uv run --with x python ${code}`,
    `uv --quiet run --with=x -p 3.12 --frozen -- python ${code}`,
    `uv run -qw x --env-file .env python ${code}`,
    `~/.local/bin/uv run -n --no-sync python ${code}`,
    `poetry run python ${code}`,
    `poetry -q run -P sub -- python ${code}`,
  ])
  sameAs('rm -rf ~/x', [
    'flock /tmp/l rm -rf ~/x',
    'flock -n -w 5 /tmp/l rm -rf ~/x',
    'flock -nE 3 --timeout 5 -- /tmp/l rm -rf ~/x',
    'flock -- -lock rm -rf ~/x',
    "flock /tmp/l -c 'rm -rf ~/x'",
    "flock --conflict-exit-code=3 /tmp/l --command 'rm -rf ~/x'",
    'ionice -c3 rm -rf ~/x',
    'ionice -c 2 -n 7 -t rm -rf ~/x',
    'ionice --class idle -- rm -rf ~/x',
  ])
  expect(only("uv run python - <<'EOF'\nimport shutil\nshutil.rmtree('x')\nEOF")).toMatchObject({ op: 'unknown' })
  // A lone `-` runs stdin as Python.
  const body = "\nimport shutil\nshutil.rmtree('/opt/x')\nEOF"
  sameAs(`python - <<'EOF'${body}`, [`uv run - <<'EOF'${body}`, `uv run --no-project -- - <<'EOF'${body}`])
  expect(only(`uv run - <<'EOF'${body}`)).toMatchObject({ op: 'unknown', what: 'inline python code that deletes files' })
  expect(analyze(`poetry run - <<'EOF'${body}`)).toEqual([])
  expect(only('flock /tmp/l -c "$CMD"')).toMatchObject({ op: 'unknown' })
  // Other subcommands name packages, not commands; flock on a file descriptor runs nothing.
  for (const command of ['uv sync', 'uv remove rm build', 'poetry add rm build', 'uv run', 'flock 9', 'flock -u 9', 'flock /tmp/l -c "echo hi"']) {
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  }
})

test('every wrapper skips its own options, in any form, to find its command', () => {
  sameAs('rm -rf /opt/x', [
    'sudo --user root rm -rf /opt/x',
    'sudo --user=root -- rm -rf /opt/x',
    'sudo -Eu root rm -rf /opt/x',
    'sudo -uroot -g wheel rm -rf /opt/x',
    'sudo -u"$U" rm -rf /opt/x',
    'doas -u root rm -rf /opt/x',
    'nice -n5 rm -rf /opt/x',
    'nice --adjustment 5 rm -rf /opt/x',
    'nice -10 rm -rf /opt/x',
    '/usr/bin/time -l rm -rf /opt/x',
    'time -f %e rm -rf /opt/x',
    'command -- rm -rf /opt/x',
    'timeout --signal KILL -k 5 10 rm -rf /opt/x',
    'timeout -k5s 10 rm -rf /opt/x',
    'stdbuf -o L -eL rm -rf /opt/x',
    'caffeinate -di -t 60 rm -rf /opt/x',
    'exec -a name rm -rf /opt/x',
    'exec - rm -rf /opt/x',
    'exec -- - rm -rf /opt/x',
    'exec -a foo - rm -rf /opt/x',
    '- rm -rf /opt/x',
    'nohup -- rm -rf /opt/x',
    'env -i A=1 B=2 rm -rf /opt/x',
    'env - rm -rf /opt/x',
    'env -iu HOME -P /bin rm -rf /opt/x',
    'env -i - A=1 rm -rf /opt/x',
    "env -S'rm -rf /opt/x'",
    "env --split-string='rm -rf /opt/x'",
    "env --split-string 'rm -rf /opt/x'",
    'env "X=1" rm -rf /opt/x',
    "env 'X=a b' rm -rf /opt/x",
    'env "PATH=$PATH:/x" rm -rf /opt/x',
    'sudo env --unset X timeout 5 nice -n 5 rm -rf /opt/x',
    'stdbuf --output L rm -rf /opt/x',
    '/usr/bin/time --output log rm -rf /opt/x',
    "/usr/bin/time --format '%e' rm -rf /opt/x",
    'flock --wait 5 /tmp/l rm -rf /opt/x',
    'ionice --classdata 7 rm -rf /opt/x',
  ])
  expect(only('env -S "$CMD"')).toMatchObject({ op: 'unknown', what: 'env -S: $CMD is not set on this command line' })
  // command -v and -V print where each name is found.
  for (const command of ['command -v rm cp', 'command -pV rm cp', 'sudo -i', 'env -S', 'env A=1 B=2']) {
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  }
})

test('a wrapper that changes folder moves where its command is measured from', () => {
  expect(only('uv run --directory sub rm -rf build')).toMatchObject({ op: 'delete', dir: 'sub', paths: ['build'] })
  expect(only('uv --directory=/srv run rm x')).toMatchObject({ dir: '/srv' })
  expect(only('uv run --project sub rm x')).toMatchObject({ dir: null })
  expect(only('poetry -C sub run rm x')).toMatchObject({ dir: 'sub' })
  expect(only('poetry run --directory=sub rm x')).toMatchObject({ dir: 'sub' })
  expect(only('poetry --project sub run rm x')).toMatchObject({ dir: null })
  expect(only('sudo -D /srv rm x')).toMatchObject({ dir: '/srv' })
  expect(only('cd a && env --chdir=b rm x')).toMatchObject({ dir: 'a/b' })
  expect(only('uv run --directory "$D" rm x')).toEqual({
    op: 'unknown', what: 'paths relative to uv --directory with an expansion', cmd: 'uv run --directory "$D" rm x',
  })
  expect(only('env -C "$D" rm x')).toMatchObject({ op: 'unknown', what: 'paths relative to env -C with an expansion' })
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

const fromInput = { op: 'unknown', what: 'what xargs passes comes from its input' }

test('xargs and find -exec read the command they run like any other, wrappers included', () => {
  expect(only('git branch | xargs git branch -D')).toEqual({
    op: 'unknown', what: 'git with an argument only known when it runs', cmd: 'xargs git branch -D',
  })
  expect(only('git branch | grep -v main | xargs git branch -D')).toMatchObject({ op: 'unknown' })
  expect(only('ls | xargs -I{} git -C {} reset --hard')).toMatchObject({ op: 'unknown' })
  expect(only('find . -type f -exec git checkout -- {} +')).toMatchObject({ op: 'unknown' })
  expect(analyze('git branch --merged | xargs git branch -d')).toEqual([])
  for (const run of ['rm -rf', 'sudo rm -rf', 'sudo -u root rm -rf', 'env -u X nohup timeout 5 rm -rf']) {
    expect(analyze(`ls ~/old | xargs ${run}`)).toEqual([{ ...fromInput, cmd: `xargs ${run}` }])
  }
  const bak = { op: 'find', dir: null, argv: ['~/old', '-name', '*.bak', '-print'], recursive: false }
  expect(only("find ~/old -name '*.bak' -exec sudo rm -f {} \\;")).toEqual({ ...bak, cmd: "find ~/old -name '*.bak' -exec sudo rm -f {} \\;" })
  expect(only("find ~/old -name '*.bak' -exec env -i nice -n 5 rm -f {} \\;")).toMatchObject(bak)
  expect(only("find ~/old -name '*.bak' -exec sudo rm -rf {} +")).toMatchObject({ ...bak, recursive: true })
  expect(only("find ~/old -name '*.bak' -exec env LC_ALL=C rm -f {} +")).toMatchObject(bak)
  // -exec's words come after the shell's quoting, so a glob in them is read as one.
  expect(only("find ~/old -name '*.bak' -exec rm -f '*.tmp' \\;")).toMatchObject({ op: 'delete', paths: ['*.tmp'] })
  expect(only("find . -name '*.log' | xargs sudo rm -rf")).toEqual({
    op: 'find', dir: null, argv: ['.', '-name', '*.log'], recursive: true, cmd: 'xargs sudo rm -rf',
  })
  expect(only('unlink -r x')).toMatchObject({ recursive: false })
  expect(only('find . -name x | xargs rm --recursive')).toMatchObject({ op: 'find', recursive: true })
  expect(only('find . -name x -exec rm -R {} +')).toMatchObject({ op: 'find', recursive: true })
})

test('what xargs or find -exec runs is judged by its own words, the input unknown', () => {
  // A command that writes nothing, or won't clobber, isn't held for its input alone.
  for (const command of [
    'find . -name x | xargs grep foo',
    'ls | xargs',
    'ls | xargs command -v',
    'ls | xargs ln -s -t ~/bin',
    'ls | xargs tee -a log',
    "find . -name '*.sh' -exec sh -c 'echo \"$1\"' _ {} \\;",
  ]) {
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  }
  expect(only('ls | xargs mv -t ~/x')).toEqual({ ...fromInput, cmd: 'xargs mv -t ~/x' })
  expect(only('find . -type f -exec mv {} /x \\;')).toEqual({
    op: 'unknown', what: '{} in find -exec is each path it finds', cmd: 'find . -type f -exec mv {} /x \\;',
  })
  // A shell given the input as its code is held, as sh -c "$CMD" is, and so is one whose
  // code has the input inside it, or an interpreter's.
  expect(only('ls | xargs bash -c')).toMatchObject({ op: 'unknown' })
  expect(only('find . -exec sh -c {} \\;')).toMatchObject({ op: 'unknown' })
  expect(only("ls | xargs -I{} sh -c 'git branch -D {}'")).toEqual({ ...fromInput, cmd: "xargs -I{} sh -c 'git branch -D {}'" })
  expect(only("ls | xargs -I{} sh -c 'mv {} /x'")).toMatchObject(fromInput)
  expect(only("find . -exec sh -c 'git checkout -- {}' \\;")).toMatchObject({
    op: 'unknown', what: '{} in find -exec is each path it finds',
  })
  expect(only('ls | xargs -0 python3 -c')).toEqual({ ...fromInput, cmd: 'xargs -0 python3 -c' })
  expect(only("ls | xargs -I{} node -e 'console.log(\"{}\")'")).toMatchObject(fromInput)
  expect(only("find . -name '*.ts' -exec deno eval {} \\;")).toMatchObject({ op: 'unknown' })
  expect(only("ls | xargs -I{} python3 -c 'import os; os.remove(\"{}\")'")).toMatchObject(fromInput)
  // Code that only takes the input as an argument is read as it is written.
  expect(analyze("ls | xargs python3 -c 'import sys; print(sys.argv)'")).toEqual([])
  // Variables set on the line reach it, and it runs where a wrapper of xargs puts it.
  expect(only('D=build; ls | xargs -I{} rm -rf "$D"')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('ls | env -C /srv xargs -I{} rm -rf build')).toMatchObject({ op: 'delete', dir: '/srv', paths: ['build'] })
})

test("a delete fed a find's list leaves it to the dry run, and its other words are judged", () => {
  const find = { op: 'find', dir: null, argv: ['.', '-name', 'x'], recursive: true, cmd: 'xargs rm -rf ~/keep' }
  expect(analyze('find . -name x | xargs rm -rf ~/keep')).toEqual([
    { op: 'delete', dir: null, paths: ['~/keep'], recursive: true, cmd: 'xargs rm -rf ~/keep' },
    find,
  ])
  expect(analyze('D=build; find . -name x | xargs rm -rf "$D"')).toEqual([
    { op: 'delete', dir: null, paths: ['build'], recursive: true, cmd: 'xargs rm -rf "$D"' },
    { ...find, cmd: 'xargs rm -rf "$D"' },
  ])
  const exec = 'find . -name x -exec rm -rf ~/keep {} +'
  expect(analyze(exec)).toEqual([
    { op: 'delete', dir: null, paths: ['~/keep'], recursive: true, cmd: exec },
    { ...find, argv: ['.', '-name', 'x', '-print'], cmd: exec },
  ])
  // Without {}, -exec runs its command as written, once per path found.
  expect(analyze('find . -name x -exec rm -rf build \\;')).toEqual([
    { op: 'delete', dir: null, paths: ['build'], recursive: true, cmd: 'find . -name x -exec rm -rf build \\;' },
  ])
  // The list holds paths from where the find ran: a delete run anywhere else can't use it.
  expect(only('find . -name x | xargs env -C /srv rm')).toMatchObject(fromInput)
  expect(only('env -C /srv find . -name x | xargs rm')).toMatchObject(fromInput)
  expect(only('cd "$X" && find . -name x | xargs rm')).toMatchObject(fromInput)
  expect(only('find . -name x -exec env -C /srv rm {} \\;')).toMatchObject({ op: 'unknown' })
  // Only a word that is the input alone is one of the find's paths; one built from it is not.
  expect(only('find . -name x | xargs -I{} rm -rf ~/backup/{}')).toEqual({ ...fromInput, cmd: 'xargs -I{} rm -rf ~/backup/{}' })
  expect(only("find . -name '*.c' | xargs -I{} rm {}.bak")).toMatchObject(fromInput)
  expect(only('find . -name x -exec rm -rf ~/backup/{} \\;')).toMatchObject({ op: 'unknown' })
  expect(only('find . -name x -exec rm -f {}.bak \\;')).toMatchObject({ op: 'unknown' })
  expect(analyze('find . -name x | xargs -I{} rm -rf {} {}.bak').map(e => e.op)).toEqual(['unknown', 'find'])
  // -execdir runs in each folder found: its list is the find's, other relative paths are unknown.
  expect(only('find . -name x -execdir rm {} \\;')).toMatchObject({ op: 'find', argv: ['.', '-name', 'x', '-print'] })
  expect(only('find . -name x -execdir cp /etc/hosts ../x \\;')).toMatchObject({
    op: 'unknown', what: 'paths relative to each folder find -execdir runs in',
  })
  expect(only('find . -name x -okdir cp /etc/hosts ../x \\;')).toMatchObject({
    op: 'unknown', what: 'paths relative to each folder find -okdir runs in',
  })
  // A folder moved from one that is unknown is another folder, not the find's.
  expect(only('find . -name x -execdir env -C .. rm {} \\;')).toMatchObject({ op: 'unknown' })
  expect(only('find . -name x -exec cp /etc/hosts ../x \\;')).toMatchObject({ op: 'copy', dest: ['../x'] })
  // A find's other -exec does nothing in the dry run an xargs rm reads.
  expect(only('find . -name x -exec touch {} + | xargs rm')).toMatchObject({ op: 'find', argv: ['.', '-name', 'x', '-true'] })
})

test("xargs's options: where its command starts and where its input goes", () => {
  for (const opts of [
    '-n1', '-n 1', '-0n 1', '-0r', '--max-args 1', '--max-args=1', '--arg-file list', '-a list', '-0 --', '-ei',
    '--delimiter x', '--max-procs 2', '--max-chars 100', '--process-slot-var V',
  ]) {
    const command = `ls | xargs ${opts} rm -f`
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: fromInput })
  }
  // -I, -i and --replace put the input in place of their text, and nowhere else.
  for (const opts of ['-I{}', '-I %', '-i', '-rI {}', '--replace', '-J% -I%']) {
    const command = `ls | xargs ${opts} rm -rf build`
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { op: 'delete', paths: ['build'] } })
  }
  // BSD's -J replaces only a word that is exactly its text, and else adds the input after.
  expect(only('ls | xargs -J % rm -rf build')).toEqual({ ...fromInput, cmd: 'xargs -J % rm -rf build' })
  expect(only('ls | xargs -I% -J% rm -rf build')).toMatchObject(fromInput)
  expect(only('ls | xargs -J % rm -rf %/x')).toMatchObject(fromInput)
  expect(only('ls | xargs -J % mv % /dest')).toMatchObject(fromInput)
  expect(analyze('find . -name x | xargs -J % rm -rf build').map(e => e.op)).toEqual(['delete', 'find'])
  expect(analyze('find . -name x | xargs -J % rm -rf % build').map(e => e.op)).toEqual(['delete', 'find'])
  expect(analyze('find . -name x | xargs -J % rm -rf %/x build')).toMatchObject([
    { op: 'delete', paths: ['%/x', 'build'] },
    { op: 'find' },
  ])
  expect(analyze("P=%; find . -name x | xargs -J % rm -rf \"$P\" build").map(e => e.op)).toEqual(['delete', 'find'])
  // A replace text the shell expands is read as its value; one only known when it runs is held.
  expect(only('R={}; ls | xargs -I "$R" rm -rf ~/keep')).toMatchObject({ op: 'delete', paths: ['~/keep'] })
  for (const command of ['ls | xargs -I "$R" rm -rf ~/keep', 'ls | xargs -I', "ls | xargs -I '' rm x"]) {
    expect({ command, effect: only(command) }).toMatchObject({
      command, effect: { op: 'unknown', what: 'what xargs -I or -J replaces is only known when it runs' },
    })
  }
  expect(only('R=%; ls | xargs -I "$R" rm -rf %')).toMatchObject(fromInput)
  expect(only('R=%; ls | xargs -I "$R" rm -rf build')).toMatchObject({ op: 'delete', paths: ['build'] })
  // An option with an expansion in it is read from its literal head. One that reaches an
  // option taking a value, or a long one with `=`, still ends where it is.
  expect(only('ls | xargs -I"$R" rm -rf ~/keep')).toEqual({
    op: 'unknown', what: 'what xargs -I or -J replaces is only known when it runs', cmd: 'xargs -I"$R" rm -rf ~/keep',
  })
  for (const command of [
    'find . -name x | xargs -P$(nproc) -n1 gzip',
    'ls | xargs --max-procs=$(nproc) grep foo',
    'ls | xargs -n"$N" grep foo',
    'ls | xargs -0P$(nproc) grep foo',
  ]) {
    expect({ command, effects: analyze(command) }).toEqual({ command, effects: [] })
  }
  expect(only('ls | xargs -P$(nproc) rm -rf ~/keep')).toMatchObject(fromInput)
  expect(only('ls | xargs --max-procs=$N rm -f')).toMatchObject(fromInput)
  expect(only('R=%; ls | xargs -I"$R" rm -rf build')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('R=%; ls | xargs -i"$R" rm -rf build')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('R=x; ls | xargs -I%"$R" rm -rf %x')).toMatchObject(fromInput)
  expect(only('R=x; ls | xargs -I%"$R" rm -rf x')).toMatchObject({ op: 'delete', paths: ['x'] })
  expect(only('R=%; ls | xargs --replace="$R" rm -rf build')).toMatchObject({ op: 'delete', paths: ['build'] })
  expect(only('R=%; ls | xargs -J"$R" rm -rf build')).toMatchObject(fromInput)
  expect(only('find . -name x | xargs -a"$F" rm')).toMatchObject(fromInput)
  expect(only('find . -name x | xargs --arg-file="$F" rm')).toMatchObject(fromInput)
  // One whose head can't say where the option ends hides where the command starts.
  for (const command of ['ls | xargs -$X rm -rf ~/keep', 'ls | xargs -0$X rm -rf ~/keep', 'ls | xargs --$X rm -rf ~/keep']) {
    expect({ command, effect: only(command) }).toMatchObject({
      command, effect: { op: 'unknown', what: 'xargs options only known when it runs' },
    })
  }
  // A variable whose value holds the replace text is the input there.
  expect(only("D='{}'; ls | xargs -I{} rm -rf \"$D\"")).toMatchObject(fromInput)
  expect(only("D='~/backup/{}'; find . -name x | xargs -I{} rm -rf \"$D\"")).toMatchObject(fromInput)
  expect(analyze("D='{}'; find . -name x | xargs -I{} rm -rf \"$D\"").map(e => e.op)).toEqual(['find'])
  expect(only('for d in b a/{}; do ls | xargs -I{} rm -rf "$d"; done')).toMatchObject(fromInput)
  expect(only('for d in b {}; do find . -name x | xargs -I{} rm -rf "$d"; done')).toMatchObject(fromInput)
  expect(only('for d in a b; do ls | xargs -I{} rm -rf "$d"; done')).toMatchObject({ op: 'delete', paths: ['a', 'b'] })
  expect(only('ls | xargs -I{} rm -rf "$X"')).toMatchObject({ op: 'unknown', what: '$X is not set on this command line' })
  // So is one -J could replace in some runs of a loop and not others.
  expect(analyze('for p in % b; do find . -name x | xargs -J % rm -rf "$p"; done')).toMatchObject([
    { op: 'delete', paths: ['%', 'b'] },
    { op: 'find' },
  ])
  expect(analyze('find . -name x | xargs -J % rm -rf % %/x')).toMatchObject([{ op: 'delete', paths: ['%/x'] }, { op: 'find' }])
  // Only the first word that is exactly the text: a second one stays literal.
  expect(analyze('find . -name x | xargs -J % rm -rf % %')).toMatchObject([{ op: 'delete', paths: ['%'] }, { op: 'find' }])
  expect(only('for r in % {}; do ls | xargs -I "$r" rm -rf %; done')).toMatchObject({
    op: 'unknown', what: 'what xargs -I or -J replaces is only known when it runs',
  })
  for (const command of [
    "ls | xargs -I{} sh -c 'rm -rf {}'",
    'ls | xargs -I % sh -c %',
    'ls | xargs -i% rm %',
    'ls | xargs --replace=% rm %',
    'ls | xargs -I{} rm {}/x',
  ]) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: fromInput })
  }
  // Read from a file, the input isn't the find's list.
  expect(only('find . -name x | xargs -a list rm')).toMatchObject(fromInput)
  expect(only('find . -name x | xargs --arg-file=list rm')).toMatchObject(fromInput)
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

test('git commands that move an existing branch go to the judge; making a new one does not', () => {
  expect(only('git checkout -B main origin/main')).toEqual({ op: 'git', dir: null, argv: ['checkout', '-B', 'main', 'origin/main'], cmd: 'git checkout -B main origin/main' })
  expect(only('git switch -C main origin/main')).toMatchObject({ op: 'git', argv: ['switch', '-C', 'main', 'origin/main'] })
  expect(only('git branch -f main HEAD~3')).toMatchObject({ op: 'git', argv: ['branch', '-f', 'main', 'HEAD~3'] })
  for (const argv of [
    ['checkout', '-B', 'x'], ['checkout', '-qB', 'x', 'main'], ['checkout', '-Bx'],
    ['switch', '-C', 'x'], ['switch', '-qC', 'x'], ['switch', '--force-create', 'x'], ['switch', '--force-create=x'],
    ['branch', '-f', 'x', 'main'], ['branch', '--force', 'x'], ['branch', '-qf', 'x'],
    ['branch', '-M', 'a', 'b'], ['branch', '-C', 'a', 'b'], ['branch', '-m', '--force', 'a', 'b'],
    // and the force that discards changes, however it is spelled
    ['checkout', '-b', 'x', '-qf'], ['checkout', '-b', 'x', '--force'], ['switch', '-qf', 'main'], ['switch', '--force', 'main'],
  ]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: true })
  }
  for (const argv of [
    ['checkout', '-b', 'x', 'main'], ['checkout', '--orphan', 'x'], ['switch', '-c', 'x', 'main'], ['switch', '--create=x'],
    ['branch', 'x', 'main'], ['branch', '-m', 'a', 'b'], ['branch', '-c', 'a', 'b'], ['branch', '-u', 'origin/x'],
    ['branch', '--format=%(refname:short)'],
    // A listing option's value is never read as options, so the f in it forces nothing.
    ['branch', '--format', '-> %(refname) from %(upstream)'],
    ['branch', '--sort', '-refname'],
    ['branch', '--points-at', '-fixup'],
  ]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: false })
  }
})

test('git short options combined in one word count one by one, as git reads them', () => {
  for (const argv of [
    ['branch', '-df', 'x'],
    ['branch', '-fd', 'x'],
    ['branch', '-qD', 'x'],
    ['checkout', '-fb', 'new'],
    ['checkout', '-qfb', 'new'],
    ['checkout', '-fbfix/x'],
    // -bnew holds its own value, so the next word is options again.
    ['checkout', '-bnew', '-qf'],
    ['switch', '-qf', 'main'],
    ['restore', '-SW', 'a'],
    ['rm', '-qf', 'x'],
    ['rm', '-r', '--force', 'x'],
    // A value, and every word after --, is never read as options.
    ['clean', '-fe', '-nq'],
    ['clean', '-f', '--exclude', '-nq'],
    ['clean', '-f', '--', '-nq'],
  ]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: true })
  }
  for (const argv of [
    ['branch', '-dq', 'x'],
    ['checkout', '-qb', 'new'],
    ['checkout', '-bfix'],
    // A cluster with a non-letter still splits: -q -b, and fix/x is -b's value.
    ['checkout', '-qbfix/x'],
    ['switch', '-cf', 'main'],
    ['restore', '-Sq', 'a'],
    ['restore', '-SsWIP', 'a'],
    ['branch', '-uorigin/Dev'],
    ['rm', '-rq', 'x'],
    ['clean', '-nfd'],
  ]) {
    expect({ argv, risky: gitRisky(argv) }).toEqual({ argv, risky: false })
  }
  expect(only('git branch -df topic')).toEqual({ op: 'git', dir: null, argv: ['branch', '-df', 'topic'], cmd: 'git branch -df topic' })
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
  // Every command's -t takes the folder, whether apart from or joined to other options.
  for (const command of ['mv -t ~/d a b', 'install -t ~/d a b', 'ln -sf -t ~/d a b', 'ln -sft ~/d a b']) {
    expect({ command, effect: only(command) }).toMatchObject({ command, effect: { sources: ['a', 'b'], dest: ['~/d'], intoDir: true } })
  }
  // install keeps the backup and -T options it shares with the others.
  for (const command of ['install -b a ~/b', 'install --backup a ~/b']) none(command)
  expect(only('install -T a ~/b')).toMatchObject({ noTargetDir: true })
  for (const kind of ['t', 'numbered', 'existing', 'nil', 'simple', 'never']) none(`cp --backup=${kind} a ~/b`)
  // `ln [-f] TARGET` links into the working folder under the target's own name.
  expect(only('ln -sf /x/.zshrc')).toMatchObject({ mode: 'ln', sources: ['/x/.zshrc'], dest: ['.'], intoDir: true, noClobber: false })
  expect(only('cd ~ && ln -sfn dotfiles/.zshrc')).toMatchObject({ mode: 'ln', sources: ['dotfiles/.zshrc'], dest: ['.'], intoDir: true })
  none('ln -s /x/.zshrc')
  // mv, cp and install need two operands, and ln needs one.
  for (const command of ['mv a', 'cp -f a', 'install a', 'ln -sf']) none(command)
  // An explicit -t beats the one-operand fallback.
  expect(only('ln -sf -t ~/d a')).toMatchObject({ sources: ['a'], dest: ['~/d'], intoDir: true })
  expect(only('cp -- -n ~/b')).toMatchObject({ sources: ['-n'], dest: ['~/b'], noClobber: false })
  expect(only('cp - ~/b')).toMatchObject({ sources: ['-'], dest: ['~/b'] })
  expect(only('cp "$SRC" ~/b')).toMatchObject({ op: 'unknown' })
})
