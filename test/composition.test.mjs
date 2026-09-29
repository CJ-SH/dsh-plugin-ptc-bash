/**
 * The host half's own reading of `presets/ptc-bash/**`.
 *
 * 0.2.0-rc.1 makes the package itself the only reader of those files: the roster that
 * used to scan `$DSH_HOME/.agent-presets` is gone, so a construct this reader gets wrong
 * reaches a live session instead of being caught by a discovery pass. Two things follow,
 * and both are asserted here: the reader must read the shipped file exactly, and it must
 * refuse anything it does not understand rather than drop a row.
 *
 * `test/composition-health.test.mjs` holds the other half of that contract — it parses
 * the same file with the installed loader's own dialect and compares row by row.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'
import { apply, compositionRows, parseComposition, parseYaml, readDefinition, validateComposition } from '../lib/index.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const presetDirectory = join(packageRoot, 'presets', 'ptc-bash')
const composition = await readFile(join(presetDirectory, 'agent.cordis.yml'), 'utf8')
const hostHalf = await readFile(join(packageRoot, 'lib', 'index.js'), 'utf8')

const fixtures = []

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-bash-preset-'))
  fixtures.push(root)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, 'presets', 'ptc-bash'), { recursive: true })
    await writeFile(join(root, 'presets', 'ptc-bash', name), text)
  }
  return root
}

after(async () => {
  for (const root of fixtures) await rm(root, { recursive: true, force: true })
})

describe('parseYaml', () => {
  it('reads block mappings, sequences and an item whose first pair is inline', () => {
    const document = parseYaml([
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    suffix: tail',
      '',
      '- id: planning',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      '    planMode: true',
      '  config:',
      '    - id: plan-mode',
      "      name: '@deepseek-ai/dsh-plan-mode'",
      '',
    ].join('\n'))
    assert.deepEqual(document, [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'tail' } },
      {
        id: 'planning',
        name: 'cordis:group',
        group: true,
        isolate: { planMode: true },
        config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }],
      },
    ])
  })

  it('reads a bare sequence item and a nested sequence under one', () => {
    assert.deepEqual(parseYaml('- one\n-\n  - two\n'), ['one', ['two']])
    assert.deepEqual(parseYaml('rows:\n  - a\n  - b\n'), { rows: ['a', 'b'] })
  })

  it('reads literal and folded block scalars with their chomping indicators', () => {
    const literal = parseYaml('section: |\n  first\n\n  second\n')
    assert.equal(literal.section, 'first\n\nsecond\n')
    assert.equal(parseYaml('section: |-\n  only\n').section, 'only')
    assert.equal(parseYaml('prefix: >-\n  one line, folded\n').prefix, 'one line, folded')
    assert.equal(parseYaml('prefix: >\n  one\n\n  two\n').prefix, 'one\ntwo\n')
    // The block's content is text: a `- id:` line inside it is not a row.
    assert.equal(parseYaml('section: |\n  - id: not-a-row\n  # not a comment\n').section, '- id: not-a-row\n# not a comment\n')
  })

  it('reads quoted scalars and keeps a # inside them', () => {
    assert.deepEqual(parseYaml("a: 'it''s here'\nb: \"tab\\there\"\nc: 'a # b'\n"), { a: "it's here", b: 'tab\there', c: 'a # b' })
  })

  it('reads !!js as the expression node the loader evaluates', () => {
    const document = parseYaml("disabled: !!js process.platform === 'win32'\n")
    assert.deepEqual(document.disabled, { __jsExpr: "process.platform === 'win32'" })
    // The loader's own test for that node is `value instanceof Object && '__jsExpr' in value`,
    // so a plain object is what an expression has to be.
    assert.ok(document.disabled instanceof Object && '__jsExpr' in document.disabled)
  })

  it('coerces plain scalars the way the loader dialect does', () => {
    assert.deepEqual(parseYaml('a: true\nb: false\nc: 65536\nd: 1.5\ne: null\nf: 0644\ng: yes\nh: off\n'), {
      a: true,
      b: false,
      c: 65536,
      d: 1.5,
      e: null,
      f: '0644',
      g: 'yes',
      h: 'off',
    })
  })

  it('drops comments and blank lines but never a value', () => {
    assert.deepEqual(parseYaml('# leading\n\na: 1 # trailing\n\n# between\nb: two\n'), { a: 1, b: 'two' })
  })

  it('refuses a construct it cannot read instead of guessing', () => {
    const cases = [
      ['an anchor', 'a: &x 1\n'],
      ['a document marker', '---\na: 1\n'],
      ['an unclosed quote', "name: './x.mjs\n"],
      ['a flow collection', 'a: [1, 2]\n'],
      ['a duplicate key', 'a: 1\na: 2\n'],
      ['unexpected indentation', 'a: 1\n    b: 2\nc: 3\n'],
      ['a block scalar as a list item', '- |\n  text\n'],
    ]
    for (const [label, text] of cases) {
      assert.throws(() => parseYaml(text), /line \d+:/, label + ' is refused with its line number')
    }
  })
})

describe('parseComposition', () => {
  it('reads the shipped composition, blocks scalar and gates included', () => {
    const rows = parseComposition(composition)
    assert.equal(rows.length, 22)
    assert.equal(rows[0].id, 'persona')
    assert.deepEqual(rows.find((row) => row.id === 'dsh-bash-win').disabled, { __jsExpr: "process.platform !== 'win32'" })
    const planning = rows.find((row) => row.id === 'planning')
    assert.equal(planning.config[0].id, 'plan-mode')
    assert.match(planning.config[0].config.section, /You are in plan mode/)
    assert.match(planning.config[0].config.section, /exit_plan_mode succeeds/)
  })

  it('refuses a document that is not a row list', () => {
    assert.throws(() => parseComposition('name: x\n'), /must be a top-level list/)
    assert.throws(() => parseComposition(''), /must be a top-level list/)
  })
})

describe('validateComposition', () => {
  it('accepts the shipped composition', () => {
    assert.deepEqual(validateComposition(composition), [])
  })

  it('reports a document that is not a row list at all', () => {
    assert.match(validateComposition('name: x\n')[0], /must be a top-level list/)
    assert.match(validateComposition('')[0], /must be a top-level list/)
  })

  it('reports an empty roster, a missing name, a duplicate id and a bad specifier', () => {
    assert.deepEqual(validateComposition('# only comments\n'), ['the composition must be a top-level list of plugin rows'])
    assert.deepEqual(validateComposition('- id: persona\n'), ['row "persona" has no name'])
    assert.deepEqual(validateComposition('- id: persona\n  name: ./a.mjs\n- id: persona\n  name: ./b.mjs\n'), ['duplicate row id "persona"'])
    assert.deepEqual(validateComposition('- id: persona\n  name: pwsh\n'), ['row "persona" name "pwsh" is not a mountable specifier'])
    assert.deepEqual(validateComposition('- name: ./a.mjs\n'), ['a row has no id'])
    assert.deepEqual(validateComposition('- just-a-scalar\n'), ['a row is not a mapping'])
  })

  it('reports a group row whose children are not a row list', () => {
    assert.deepEqual(validateComposition('- id: planning\n  name: cordis:group\n  group: true\n  config: 3\n'), [
      'group row "planning" has no child row list',
    ])
  })

  it('reports a name scalar that no longer reads back', () => {
    const broken = composition.replace("name: '@deepseek-ai/dsh-persona'", "name: '@deepseek-ai/dsh-persona")
    assert.match(validateComposition(broken)[0], /^line 31: a single-quoted scalar never closes$/)
  })

  it('leaves package resolution to the installed registry', () => {
    // Deliberate: no string comparison can tell whether `@deepseek-ai/dsh-persona` still
    // exists, so this half does not pretend to. `test/composition-health.test.mjs` runs
    // the real lookup and the negative case that proves it turns red.
    const removed = composition.replace("name: '@deepseek-ai/dsh-agent-instructions'", "name: '@deepseek-ai/dsh-agent-presets'")
    assert.notEqual(removed, composition, 'the mutation landed')
    assert.deepEqual(validateComposition(removed), [])
  })
})

describe('compositionRows', () => {
  it('publishes exactly the two local rows as file URLs', async () => {
    const source = parseComposition(composition)
    const rows = compositionRows(source, presetDirectory)
    const local = rows.filter((row) => typeof row.name === 'string' && row.name.startsWith('file:'))
    assert.deepEqual(local.map((row) => row.id), ['workspace-instructions', 'dsh-bash-win'])
    for (const row of local) {
      const file = fileURLToPath(row.name)
      assert.equal((await stat(file)).isFile(), true, row.id + ' points at a file')
      assert.equal(file.startsWith(presetDirectory), true, row.id + ' stays inside the preset directory')
    }
    // Nothing else moved: the registry resolves package names itself.
    const localIds = source.filter((row) => /^\.{1,2}\//.test(row.name)).map((row) => row.id)
    assert.deepEqual(rows.filter((row) => !localIds.includes(row.id)), source.filter((row) => !localIds.includes(row.id)))
  })

  it('rewrites a nested group row too, because the registry mounts it as well', () => {
    const rows = compositionRows([{ id: 'g', name: 'cordis:group', group: true, config: [{ id: 'x', name: './x.mjs' }] }], presetDirectory)
    assert.equal(rows[0].config[0].name, pathToFileURL(join(presetDirectory, 'x.mjs')).href)
    assert.equal(rows[0].name, 'cordis:group')
  })
})

describe('readDefinition', () => {
  it('reads the shipped display fields and rows', async () => {
    const definition = await readDefinition()
    assert.equal(definition.id, 'ptc-bash')
    assert.equal(definition.name, 'PTC + Bash 模式')
    assert.equal(definition.order, 5)
    assert.ok(definition.description.length > 0)
    // The rows are the composition's, with the two local names resolved.
    const rows = compositionRows(parseComposition(composition), presetDirectory)
    assert.deepEqual(definition.plugins, rows)
  })

  it('refuses a preset.yml that is not a mapping of display fields', async () => {
    const root = await fixture({ 'preset.yml': '- not a mapping\n', 'agent.cordis.yml': composition })
    await assert.rejects(() => readDefinition(root), /preset\.yml: expected a mapping/)
  })

  it('refuses a display field of the wrong type', async () => {
    const root = await fixture({ 'preset.yml': 'name: x\norder: five\n', 'agent.cordis.yml': composition })
    await assert.rejects(() => readDefinition(root), /order must be a number/)
  })

  it('reports a missing file instead of publishing an empty preset', async () => {
    const root = await fixture({ 'preset.yml': 'name: x\n' })
    await assert.rejects(() => readDefinition(root), /ENOENT/)
  })
})

describe('apply', () => {
  const registry = (calls, options = {}) => ({
    async register(definition) {
      calls.registered.push(definition)
      if (options.refuse === true) throw new Error('Duplicate agent preset: ptc-bash')
      return async () => {
        calls.disposed += 1
      }
    },
  })

  function fakeContext(calls, options) {
    return {
      agentPresets: registry(calls, options),
      logger: { warn: (message) => calls.warnings.push(message) },
      effect: (callback) => calls.effects.push(callback),
    }
  }

  function newCalls() {
    return { registered: [], warnings: [], effects: [], disposed: 0 }
  }

  it('registers the definition the package ships through the service it injects', async () => {
    const calls = newCalls()
    await apply(fakeContext(calls))
    assert.equal(calls.registered.length, 1)
    assert.deepEqual(calls.registered[0], await readDefinition())
    assert.equal(calls.warnings.length, 0)
  })

  it('owns the registration, so a reload cannot leave a duplicate behind', async () => {
    const calls = newCalls()
    await apply(fakeContext(calls))
    assert.equal(calls.effects.length, 1)
    const disposer = calls.effects[0]()
    assert.equal(typeof disposer, 'function', 'the effect returns its own disposer')
    disposer()
    assert.equal(calls.disposed, 1)
  })

  it('never throws when the registry refuses the declaration', async () => {
    const calls = newCalls()
    await apply(fakeContext(calls, { refuse: true }))
    assert.equal(calls.registered.length, 1, 'the declaration reached the registry')
    assert.equal(calls.warnings.length, 1)
    assert.match(calls.warnings[0], /preset registration failed — Duplicate agent preset: ptc-bash/)
  })

  it('declares the registry service and nothing else', async () => {
    const host = await import('../lib/index.js')
    assert.deepEqual(host.inject, ['agentPresets'])
    assert.equal(typeof host.apply, 'function')
    assert.equal(host.name, 'dsh-plugin-ptc-bash')
  })

  it('imports no harness package, which is the constraint the host half lives under', () => {
    assert.deepEqual(hostHalf.match(/^\s*import\s[^\n]*from\s*['"]@deepseek-ai\//gm), null)
    assert.deepEqual(hostHalf.match(/require\(\s*['"]@deepseek-ai\//g), null)
  })
})
