import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { syncPresets, validateComposition } from '../lib/index.js'

const COMPOSITION = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '',
  '- id: custom-bash',
  '  name: ./custom-bash.mjs',
  "  disabled: !!js process.platform !== 'win32'",
  '',
].join('\n')

const fixtures = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ptc-bash-sync-'))
  const sourceRoot = join(root, 'source')
  const targetBase = join(root, 'target')
  await mkdir(sourceRoot, { recursive: true })
  await writeFile(join(sourceRoot, 'agent.cordis.yml'), COMPOSITION)
  await writeFile(join(sourceRoot, 'preset.yml'), 'name: test\n')
  await writeFile(join(sourceRoot, 'custom-bash.mjs'), 'export const name = "x"\n')
  await mkdir(join(targetBase, 'liangshen'), { recursive: true })
  await writeFile(join(targetBase, 'liangshen', 'sentinel'), 'untouched\n')
  const kept = { root, sourceRoot, targetBase, targetRoot: join(targetBase, 'ptc-bash') }
  fixtures.push(root)
  return kept
}

after(async () => {
  for (const root of fixtures) await rm(root, { recursive: true, force: true })
})

describe('syncPresets', () => {
  it('copies the tree once and skips it afterwards', async () => {
    const { sourceRoot, targetRoot } = await fixture()
    const first = await syncPresets({ sourceRoot, targetRoot })
    assert.deepEqual(first.failed, [])
    assert.deepEqual(first.copied, ['agent.cordis.yml', 'custom-bash.mjs', 'preset.yml'])
    assert.deepEqual(first.skipped, [])
    assert.equal(await readFile(join(targetRoot, 'custom-bash.mjs'), 'utf8'), 'export const name = "x"\n')
    const before = await stat(join(targetRoot, 'preset.yml'))
    const second = await syncPresets({ sourceRoot, targetRoot })
    assert.deepEqual(second.copied, [])
    assert.deepEqual(second.removed, [])
    assert.deepEqual(second.skipped, ['agent.cordis.yml', 'custom-bash.mjs', 'preset.yml'])
    assert.equal((await stat(join(targetRoot, 'preset.yml'))).mtimeMs, before.mtimeMs)
  })

  it('skips identical files even when the source mtime is old', async () => {
    const { sourceRoot, targetRoot } = await fixture()
    const past = new Date(Date.now() - 600000)
    for (const file of ['agent.cordis.yml', 'custom-bash.mjs', 'preset.yml']) await utimes(join(sourceRoot, file), past, past)
    const first = await syncPresets({ sourceRoot, targetRoot })
    assert.equal(first.copied.length, 3)
    const second = await syncPresets({ sourceRoot, targetRoot })
    assert.deepEqual(second.copied, [])
    assert.equal(second.skipped.length, 3)
  })

  it('replaces a changed file and removes a deleted one', async () => {
    const { sourceRoot, targetRoot } = await fixture()
    await syncPresets({ sourceRoot, targetRoot })
    await writeFile(join(sourceRoot, 'custom-bash.mjs'), 'export const name = "changed"\n')
    await rm(join(sourceRoot, 'preset.yml'))
    const result = await syncPresets({ sourceRoot, targetRoot })
    assert.deepEqual(result.copied, ['custom-bash.mjs'])
    assert.deepEqual(result.removed, ['preset.yml'])
    assert.equal(await readFile(join(targetRoot, 'custom-bash.mjs'), 'utf8'), 'export const name = "changed"\n')
    await assert.rejects(stat(join(targetRoot, 'preset.yml')))
  })

  it('refuses an unmountable composition and leaves the target alone', async () => {
    const { sourceRoot, targetRoot } = await fixture()
    await syncPresets({ sourceRoot, targetRoot })
    const composition = await readFile(join(targetRoot, 'agent.cordis.yml'), 'utf8')
    await writeFile(join(sourceRoot, 'agent.cordis.yml'), '- id: persona\n- id: persona\n')
    const result = await syncPresets({ sourceRoot, targetRoot })
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].reason, /no two-space-indented name|duplicate row id/)
    assert.deepEqual(result.copied, [])
    assert.equal(await readFile(join(targetRoot, 'agent.cordis.yml'), 'utf8'), composition)
  })

  it('never touches a sibling preset', async () => {
    const { sourceRoot, targetBase, targetRoot } = await fixture()
    await syncPresets({ sourceRoot, targetRoot })
    await writeFile(join(sourceRoot, 'preset.yml'), 'name: changed\n')
    await syncPresets({ sourceRoot, targetRoot })
    assert.equal(await readFile(join(targetBase, 'liangshen', 'sentinel'), 'utf8'), 'untouched\n')
  })
})

describe('validateComposition', () => {
  it('accepts a composition whose rows are mountable', () => {
    assert.deepEqual(validateComposition(COMPOSITION), [])
  })

  it('reports an empty document, a missing name, a duplicate id and a bad specifier', () => {
    assert.match(validateComposition('\n# only comments\n')[0], /no top-level/)
    assert.match(validateComposition('- id: persona\n')[0], /no two-space-indented name/)
    assert.match(validateComposition(COMPOSITION + '- id: persona\n  name: ./x.mjs\n').join(' '), /duplicate row id/)
    assert.match(validateComposition('- id: persona\n  name: pwsh\n')[0], /not a mountable specifier/)
  })
})
