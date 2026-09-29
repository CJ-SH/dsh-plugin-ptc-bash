import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { parseComposition, validateComposition } from '../lib/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const presetDir = join(root, 'presets', 'ptc-bash')
const composition = (await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8')).replace(/\r\n/g, '\n')

const SHIPPED_IDS = ['minimal', 'standard', 'ptc', 'cordis']
const OFFICIAL_TOP_LEVEL_ROWS = [
  'persona',
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'planning',
  'compaction',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'tool-presentation',
  'present',
  'tool-plugin-manager',
]

function topLevelIds(text) {
  return text
    .split('\n')
    .map((line) => /^- id:\s*(.+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1].trim())
}

function expectedRoster() {
  const expected = []
  for (const id of OFFICIAL_TOP_LEVEL_ROWS) {
    expected.push(id)
    if (id === 'agent-instructions') expected.push('workspace-instructions')
    if (id === 'tool-pwsh') expected.push('dsh-bash-win')
  }
  return expected
}

describe('presets/ptc-bash', () => {
  it('is the official ptc roster plus exactly two rows', () => {
    const expected = expectedRoster()
    // Read from the text, so a reader that lost a row cannot make this agree with itself,
    // and from the parser, so a row the reader cannot see is named here as well.
    assert.deepEqual(topLevelIds(composition), expected)
    assert.deepEqual(parseComposition(composition).map((row) => row.id), expected)
  })

  it('keeps the official shell gates and adds the win32 Git Bash row', () => {
    assert.match(composition, /^- id: tool-bash\n  name: '@deepseek-ai\/dsh-tool-bash'\n  disabled: !!js process\.platform === 'win32'$/m)
    assert.match(composition, /^- id: tool-pwsh\n  name: '@deepseek-ai\/dsh-tool-pwsh'\n  disabled: !!js process\.platform !== 'win32'$/m)
    assert.match(composition, /^- id: dsh-bash-win\n  name: \.\/dsh-bash-win\.mjs\n  disabled: !!js process\.platform !== 'win32'$/m)
  })

  it('declares PTC once and stays free of the anchor-turn machinery', () => {
    assert.match(composition, /- id: tool-presentation\n  name: '@deepseek-ai\/dsh-agent-tool-presentation'\n  config:\n    mode: ptc\n/)
    assert.ok(!composition.includes('tool-catalog'))
    assert.ok(!composition.includes('str_replace_editor'))
    assert.equal(composition.match(/mode: ptc/g).length, 1)
  })

  it('routes workspace instructions through the system prompt', () => {
    assert.match(composition, /- id: workspace-instructions\n  name: \.\/workspace-instructions\.mjs\n  config:\n    instructionMaxBytes: 65536\n/)
    assert.match(composition, /- id: agent-instructions\n  name: '@deepseek-ai\/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n/)
  })

  it('names the current engine package and nothing this preset has outlived', () => {
    assert.match(composition, /^    - id: workflow-ptc\n^      name: '@deepseek-ai\/dsh-workflow-ptc'$/m)
    // 0.1.6 removed dsh-workflow-worker-thread (renamed to dsh-workflow-ptc) and never
    // shipped a dsh-tool-ptc; a row naming either one fails the mount. The lookup that
    // proves the names still resolve lives in test/composition-health.test.mjs — this is
    // only the text half, and it cannot tell a rename from a typo.
    assert.ok(!composition.includes('workflow-worker-thread'))
    assert.ok(!composition.includes('dsh-tool-ptc'))
  })

  it('keeps the orchestration rows disabled exactly as upstream ptc does', () => {
    // The comment lines between `name` and `disabled` travel with the row, so
    // the assertions tolerate them rather than pinning the prose.
    assert.match(composition, /^    - id: workflow-ptc\n^      name: '@deepseek-ai\/dsh-workflow-ptc'\n(?:^      #.*\n)*^      disabled: true$/m)
    assert.match(composition, /^    - id: tool-workflow\n^      name: '@deepseek-ai\/dsh-tool-workflow'\n(?:^      #.*\n)*^      disabled: true$/m)
    assert.match(composition, /^    - id: tool-ralph\n^      name: '@deepseek-ai\/dsh-tool-ralph'\n(?:^      #.*\n)*^      disabled: true$/m)
    assert.match(composition, /^- id: tool-plugin-manager\n  name: '@deepseek-ai\/dsh-plugin-manager\/tools'\n  disabled: true$/m)
  })

  it('passes the roster structural contract', () => {
    assert.deepEqual(validateComposition(composition), [])
  })

  it('publishes the id and display fields the registry registers', async () => {
    const preset = await readFile(join(presetDir, 'preset.yml'), 'utf8')
    const name = /^name:\s*(.+)$/m.exec(preset)
    const description = /^description:\s*(.+)$/m.exec(preset)
    const order = /^order:\s*(\d+)$/m.exec(preset)
    assert.ok(name !== null && name[1].trim().length > 0)
    assert.ok(description !== null && description[1].trim().length > 0)
    assert.equal(order[1], '5')
    assert.match('ptc-bash', /^[a-z0-9][a-z0-9-]*$/)
    // The registry refuses a duplicate id outright, so this preset's id must not be one
    // the deployment already ships.
    assert.ok(!SHIPPED_IDS.includes('ptc-bash'))
  })
})
