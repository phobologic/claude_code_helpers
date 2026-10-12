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

test('braces expand into the words bash makes of them, for every command', () => {
  const paths = (command: string) => (only(command) as { paths: string[] }).paths
  expect(only('rm -rf {a,b}')).toEqual({ op: 'delete', dir: null, paths: ['a', 'b'], recursive: true, cmd: 'rm -rf {a,b}' })
  expect(paths('rm -rf ~/{x,y}/z')).toEqual(['~/x/z', '~/y/z'])
  expect(paths('rm -rf .{git,x}')).toEqual(['.git', '.x'])
  expect(paths('rm {a,b{c,d}} {a,b}{1,2}')).toEqual(['a', 'bc', 'bd', 'a1', 'a2', 'b1', 'b2'])
  expect(paths('rm f{1..3} {c..a} {3..1}')).toEqual(['f1', 'f2', 'f3', 'c', 'b', 'a', '3', '2', '1'])
  expect(paths('rm {a,"b c"} {\\,a,b}')).toEqual(['a', 'b c', ',a', 'b'])
  expect(paths("rm {$'it\\'s',b} {a{b,c}} {{d,e}")).toEqual(["it's", 'b', '{ab}', '{ac}', '{d', '{e'])
  // A } closes only after a , or .. at its own level; a {} that starts the text opens nothing.
  expect(paths('rm {a},b} {a..},c} {a.},d} a{},e}')).toEqual(['a}', 'b', 'a..}', 'c', 'a.}', 'd', 'a}', 'ae'])
  // An empty word goes, unless something quoted is in it.
  expect(paths("rm {,a} ''{,b}")).toEqual(['a', '', 'b'])
  // Braces are expanded before options and positions are read.
  expect(only('mv {a,b} /elsewhere')).toMatchObject({ op: 'copy', sources: ['a', 'b'], dest: ['/elsewhere'] })
  expect(only('mv {.git,x}')).toMatchObject({ op: 'copy', sources: ['.git'], dest: ['x'] })
  expect(only('cp x {.env,.git/config}')).toMatchObject({ op: 'copy', sources: ['x', '.env'], dest: ['.git/config'] })
  expect(only('cp .env{,.bak}')).toMatchObject({ op: 'copy', sources: ['.env'], dest: ['.env.bak'] })
  expect(only('{rm,-rf,x}')).toMatchObject({ op: 'delete', paths: ['x'], recursive: true })
  expect(only('git checkout -- {a,b}.ts')).toMatchObject({ op: 'git', argv: ['checkout', '--', 'a.ts', 'b.ts'] })
  expect(only('find {a,b} -name x -delete')).toMatchObject({ op: 'find', argv: ['a', 'b', '-name', 'x', '-print'] })
  expect(only('echo x | tee {a,b}.log')).toMatchObject({ op: 'overwrite', paths: ['a.log', 'b.log'] })
  expect(paths('for d in {a,b}; do rm -rf "$d"; done')).toEqual(['a', 'b'])
  // bash refuses a redirect to several words, but zsh writes to each.
  expect(only('echo x > {a,b}')).toMatchObject({ op: 'overwrite', paths: ['a', 'b'] })
  // After brace expansion $X{a,b} names the variables Xa and Xb, as in bash.
  expect(paths('X=p; rm ${X}{a,b}')).toEqual(['pa', 'pb'])
  expect(only('X=p; rm $X{a,b}')).toMatchObject({ op: 'unknown', what: '$Xa is not set on this command line' })
})

test('braces that are quoted, escaped, unclosed or hold no list or sequence stay as written', () => {
  const paths = (command: string) => (only(command) as { paths: string[] }).paths
  expect(paths(`rm "{a,b}" '{c,d}' \\{e,f\\} {g} {} {},h} {i,j {k..} {1..2{l,m}}`)).toEqual([
    '{a,b}', '{c,d}', '{e,f}', '{g}', '{}', '{},h}', '{i,j', '{k..}', '1..2l', '1..2m',
  ])
  expect(only('find . -name x -exec rm -rf {} +')).toMatchObject({ op: 'find', argv: ['.', '-name', 'x', '-print'] })
  expect(only('git stash drop stash@{0}')).toMatchObject({ op: 'git', argv: ['stash', 'drop', 'stash@{0}'] })
  // An assignment is never brace expanded; a declaration builtin's assignment is, as in bash 3.2.
  expect(paths('X={a,b}; rm "$X"')).toEqual(['{a,b}'])
  expect(paths('export X={a,b}; rm "$X"')).toEqual(['b'])
  expect(paths('rm -rf ${HOME:-{a,b}}')).toEqual([HOME])
  // An escaped , makes no list, and a .. that makes no sequence leaves the word as
  // written when nothing after it would expand.
  expect(paths('rm {1..2\\,x} {a..b.} {a,b}{c..d.} {a..b.}{c}')).toEqual([
    '{1..2,x}', '{a..b.}', 'a{c..d.}', 'b{c..d.}', '{a..b.}{c}',
  ])
  // Braces inside a substitution are its command's own: they make one word, not two.
  const what = (command: string) => (only(command) as { what: string }).what
  expect(what('rm -rf $(mktemp {-d,-q})')).toBe('$(mktemp {-d,-q}) is only known when it runs')
  expect(what('rm -rf `mktemp {-d,-q}`')).toBe('$(mktemp {-d,-q}) is only known when it runs')
  expect(what('rm -rf <(mktemp {-d,-q})')).toBe('$(mktemp {-d,-q}) is only known when it runs')
  expect(what('rm -rf >(mktemp {-d,-q})')).toBe('$(mktemp {-d,-q}) is only known when it runs')
  expect(what('rm -rf $((pwd))')).toBe('$(pwd) is only known when it runs')
  // A quote left open hides the rest of the word, braces included.
  expect(paths("rm {a,'b}")).toEqual(['{a,b}'])
})

test('braces that make too many words, nest too deep or that shells read differently are unknown', () => {
  const what = (command: string) => (only(command) as { what: string }).what
  expect(what('rm -rf x{1..65}')).toBe('x{1..65} has too many values to check')
  expect(only('rm -rf x{1..64}')).toMatchObject({ op: 'delete' })
  expect(only('rm -rf x{64..1}')).toMatchObject({ op: 'delete' })
  expect(what('rm {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}')).toBe('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n} has too many values to check')
  expect((only('rm {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}') as { paths: string[] }).paths.length).toBe(64)
  const list = Array.from({ length: 65 }, (_, k) => `f${k}`).join(',')
  expect(what(`rm {${list}}`)).toContain('has too many values to check')
  expect(only(`rm {${list.split(',').slice(0, 64).join(',')}}`)).toMatchObject({ op: 'delete' })
  const nest = (n: number): string => (n === 0 ? 'z' : `{${n},${nest(n - 1)}}`)
  expect(only(`rm ${nest(8)}`)).toMatchObject({ op: 'delete', paths: ['8', '7', '6', '5', '4', '3', '2', '1', 'z'] })
  expect(what(`rm ${nest(9)}`)).toContain('has braces nested too deep to read')
  for (const seq of [
    '{1..9..2}', '{01..10}', '{1..010}', '{-01..1}', '{a..e..2}', '{a..Z}', '{Y..b}', '{1..99999999999999999999}',
    '{4294967296..4294967297}', '{2147483647..2147483648}', '{-2147483649..-2147483648}',
  ]) {
    expect({ seq, what: what(`rm -rf x${seq}`) }).toEqual({ seq, what: `x${seq} has a brace sequence Blast Radius doesn't expand` })
  }
  // bash 3.2 wraps a number past 32 bits, but those up to it are read as written.
  expect(only('rm -rf x{2147483646..2147483647}')).toMatchObject({ op: 'delete', paths: ['x2147483646', 'x2147483647'] })
  expect(only('rm -rf x{-2147483648..-2147483647}')).toMatchObject({ op: 'delete', paths: ['x-2147483648', 'x-2147483647'] })
  expect((only('rm x{+1..2}') as { paths: string[] }).paths).toEqual(['x1', 'x2'])
  // After braces that make nothing, bash 3.2 stops, but bash 4+ and zsh go on: in zsh
  // rm -rf [{a..s.}]{rc,zz} deletes src.
  for (const word of ['[{a..s.}]{rc,zz}', '{a..b.}{c,d}', '{a,b}{c..d.}{e,f}', '{a..b.}{1..2}', '{a..b.}{x..x}', '{a..b.}{c..d.}{e,f}']) {
    expect({ word, what: what(`rm -rf ${word}`) }).toEqual({ word, what: `${word} has braces that bash 3.2 and later shells expand differently` })
  }
  // bash 3.2 decodes $'...' before brace expansion, so its , can make a list: there
  // rm -rf {.[..$'\x2c'g]it} deletes .git.
  expect(what("rm -rf {.[..$'\\x2c'g]it}")).toBe("{.[..$'\\x2c'g]it} has $'...' in braces, which bash 3.2 decodes first")
  expect(what("rm -rf {a..$'b'}")).toContain("has $'...' in braces")
  expect(what("rm -rf {.[g$'\\x2c'..]it}")).toContain("has $'...' in braces")
  expect((only("rm {a,b$'\\x2c'c} {x$'\\x2c'y}") as { paths: string[] }).paths).toEqual(['a', 'b,c', '{x,y}'])
})

test("$'...' is decoded as bash decodes it", () => {
  const paths = (command: string) => (only(command) as { paths: string[] }).paths
  expect(paths("rm -rf $'\\x2egit' $'\\056git' $'\\u002egit' $'\\U0000002egit'")).toEqual(['.git', '.git', '.git', '.git'])
  expect(paths("rm $'a\\nb\\tc' $'it\\'s' $'\\\\' $'\\\"' $'\\?' $'\\a\\b\\e\\E\\f\\r\\v'")).toEqual([
    'a\nb\tc', "it's", '\\', '"', '[?]', '\x07\b\x1b\x1b\f\r\v',
  ])
  expect(paths("rm $'\\cA' $'\\c?' $'\\ca' $'\\777' $'\\U0010ffff'")).toEqual(['\x01', '\x7f', '\x01', '\xff', '\u{10ffff}'])
  // A NUL ends the text; escapes bash doesn't know, or with no digits, stay as written.
  expect(paths("rm $'a\\0b' $'\\q' $'\\x' $'\\u' $'\\U110000'")).toEqual(['a', '\\q', '\\x', '\\u', '\\U110000'])
  // Its glob characters are quoted, and inside double quotes it is plain text.
  expect(paths("rm $'x*' \"$'y'\"")).toEqual(['x[*]', "$'y'"])
  expect(only("bash -c $'rm -rf build\\n'")).toMatchObject({ op: 'delete', paths: ['build'] })
})

test('an unquoted variable splits into words at spaces, tabs and newlines', () => {
  const paths = (command: string) => (only(command) as { paths: string[] }).paths
  expect(paths('F="src/x.py src/y.py"; rm $F')).toEqual(['src/x.py', 'src/y.py'])
  expect(paths('F="src/x.py src/y.py"; rm "$F"')).toEqual(['src/x.py src/y.py'])
  expect(paths("F=$'a\\tb\\nc'; rm $F")).toEqual(['a', 'b', 'c'])
  expect(paths('F=" a b "; rm x${F}y')).toEqual(['x', 'a', 'b', 'y'])
  expect(paths('F=" a b "; rm $F')).toEqual(['a', 'b'])
  expect(paths('F="a  b"; rm $F$F')).toEqual(['a', 'ba', 'b'])
  expect(paths('F="a b"; rm {x,y}$F')).toEqual(['xa', 'b', 'ya', 'b'])
  expect(paths('F="-rf build"; rm $F')).toEqual(['build'])
  expect(only('F="-rf build"; rm $F')).toMatchObject({ recursive: true })
  expect(paths('LIST="a b"; for f in $LIST; do rm "$f"; done')).toEqual(['a', 'b'])
  expect(only('P=".git x"; mv $P')).toMatchObject({ op: 'copy', sources: ['.git'], dest: ['x'] })
  expect(only('C="rm -rf x"; $C')).toMatchObject({ op: 'delete', paths: ['x'] })
  // An empty unquoted variable is no word at all; a quoted one is an empty word.
  expect(analyze('E=; rm -rf $E')).toEqual([])
  expect(paths('E=; rm -rf $E/')).toEqual(['/'])
  expect(paths('E=; rm -rf "$E"')).toEqual([''])
  // Assignments, declaration builtins, here-strings and redirect targets never split.
  expect(paths('F="a b"; X=$F; rm "$X"')).toEqual(['a b'])
  expect(paths('F="a b"; export X=$F; rm "$X"')).toEqual(['a b'])
  expect(paths('F="X=a Y=b"; export $F; rm "$X" "$Y"')).toEqual(['a', 'b'])
  expect(paths('F="a b"; rm X=$F')).toEqual(['X=a', 'b'])
  expect(only('F="a b"; echo x > $F')).toMatchObject({ op: 'overwrite', paths: ['a b'] })
  // A here-string is read whole, as bash 4+ and zsh pass it, and split and joined with
  // spaces, as bash 3.2 does.
  expect(analyze("F=$'rm a\\nrm b'; bash <<< $F").map(e => (e as { paths: string[] }).paths)).toEqual([['a'], ['b'], ['a', 'rm', 'b']])
  expect(only("F=$'rm -rf\\nsrc'; bash <<< $F")).toMatchObject({ op: 'delete', paths: ['src'], recursive: true })
  expect(analyze("F=$'rm -rf\\nsrc'; bash <<< \"$F\"")).toEqual([])
  expect(only('F="rm  x"; bash <<< $F')).toMatchObject({ op: 'delete', paths: ['x'] })
  // Each reading is its own script: the first one's cd or open heredoc never reaches the
  // second, which bash 3.2 runs as `echo cd /tmp; rm -rf src` and `echo <<E ; rm -rf src`.
  expect(analyze("F=$'echo\\ncd /tmp; rm -rf src'; bash <<< $F").map(e => (e as { dir: unknown }).dir)).toEqual(['/tmp', null])
  expect(only("F=$'echo <<E\\n; rm -rf src'; bash <<< $F")).toMatchObject({ op: 'delete', dir: null, paths: ['src'] })
  // One that can't be expanded is checked as written.
  expect(only('python3 <<< "import shutil; shutil.rmtree($X)"')).toMatchObject({ op: 'unknown' })
  // Where bash 3.2's reading can't be known, that is unknown, and the whole value is read.
  expect(analyze('IFS=:; F="rm x"; bash <<< $F')).toMatchObject([
    { op: 'unknown', what: 'here-string in bash 3.2: $IFS is set on this line, so how $F splits is unknown' },
    { op: 'delete', paths: ['x'] },
  ])
  // An interpreter's code is only searched, so that is no reason to hold it.
  expect(analyze("IFS=,; X='print(1)'; python3 <<< $X")).toEqual([])
  expect(analyze("for f in 'print( 1 )' 'print(2)'; do python3 <<< $f; done")).toEqual([])
  // bash 3.2 goes to the first of several folders; later bash refuses, so nothing runs.
  expect(only('F="a b"; cd $F && rm x')).toMatchObject({ op: 'delete', dir: 'a', paths: ['x'] })
  // Tabs and newlines split as spaces do.
  expect(paths("F=$'a\\nb'; rm $F")).toEqual(['a', 'b'])
  expect(paths("F=$'a\\tb'; rm $F")).toEqual(['a', 'b'])
  // Next to a split, bash 3.2 drops a word left with only quoted nulls; without one it stays.
  expect(paths("G=' a'; rm -rf ''$G")).toEqual(['a'])
  expect(paths("H='a '; rm -rf $H''")).toEqual(['a'])
  expect(paths('X=; G=" a"; rm -rf "$X"$G')).toEqual(['a'])
  expect(paths("G='a b'; rm -rf ''$G")).toEqual(['a', 'b'])
  expect(paths("G=' a'; rm -rf 'x'$G")).toEqual(['x', 'a'])
  expect(paths('X=x; G=" a"; rm -rf "$X"$G')).toEqual(['x', 'a'])
  expect(analyze("G=' '; rm -rf ''$G")).toEqual([])
  expect(paths("E=; rm -rf ''$E")).toEqual([''])
})

test('zsh splits no variable into words, and drops one that is unquoted and empty', () => {
  const paths = (command: string) => (only(command) as { paths: string[] }).paths
  expect(paths(`zsh -c 'F="a b"; rm $F'`)).toEqual(['a b'])
  expect(paths(`zsh <<'EOF'\nF="a b"; rm -rf $F\nEOF`)).toEqual(['a b'])
  expect(paths(`zsh -c 'F="a b"; for f in $F; do rm $f; done'`)).toEqual(['a b'])
  expect(paths(`zsh -c 'IFS=:; F="a b"; rm $F'`)).toEqual(['a b'])
  expect(paths(`zsh -c 'F="a b"; echo $(rm $F)'`)).toEqual(['a b'])
  expect(analyze(`zsh -c 'E=; rm -rf $E'`)).toEqual([])
  expect(paths(`zsh -c "E=; rm -rf ''\\$E"`)).toEqual([''])
  // A shell it starts splits again, as does the line around it.
  expect(paths(`zsh -c 'F="a b"; bash -c "rm \\$F"'`)).toEqual(['a', 'b'])
  expect(analyze(`F="a b"; zsh -c 'rm $F'; rm $F`).map(e => (e as { paths: string[] }).paths)).toEqual([['a b'], ['a', 'b']])
})

test('splitting that depends on the pass or on a changed $IFS is unknown', () => {
  const what = (command: string) => (only(command) as { what: string }).what
  expect(what('for f in "a b" c; do rm $f; done')).toBe('$f has several values that split into words')
  expect(what("for f in $'a\\tb' c; do rm $f; done")).toBe('$f has several values that split into words')
  expect(what("for f in $'a\\nb' c; do rm $f; done")).toBe('$f has several values that split into words')
  // Every command that reads expanded words splits them: git, cd and bash -c too.
  expect(only('for f in "a b" c; do git checkout -- $f; done')).toMatchObject({ op: 'unknown' })
  expect(only('for f in "a b" c; do cd $f; rm x; done')).toMatchObject({ op: 'unknown' })
  expect(only('for f in "a b" c; do bash -c $f; done')).toMatchObject({ op: 'unknown' })
  expect(only('for f in "a b" c; do rm "$f"; done')).toMatchObject({ op: 'delete', paths: ['a b', 'c'] })
  expect(only('for f in a c; do rm $f; done')).toMatchObject({ op: 'delete', paths: ['a', 'c'] })
  expect(only('for f in "a b" c; do echo x > $f; done')).toMatchObject({ op: 'overwrite', paths: ['a b', 'c'] })
  expect(what('IFS=:; F=a:b; rm $F')).toBe('$IFS is set on this line, so how $F splits is unknown')
  expect(what('IFS=:; F="a b"; rm $F')).toBe('$IFS is set on this line, so how $F splits is unknown')
  expect(only('IFS=:; F="a b"; rm "$F"')).toMatchObject({ op: 'delete', paths: ['a b'] })
  expect(only('IFS=:; F="a b"; echo x > $F')).toMatchObject({ op: 'overwrite', paths: ['a b'] })
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
