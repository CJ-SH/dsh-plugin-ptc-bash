/**
 * What the installed harness itself says about `presets/ptc-bash`.
 *
 * The failure this file exists for is one the package cannot judge alone. dsh
 * 0.1.5 shipped the workflow engine as `@deepseek-ai/dsh-workflow-worker-thread`;
 * 0.1.6 renamed it to `@deepseek-ai/dsh-workflow-ptc`, and a row still naming the
 * old package parses as perfectly valid YAML — only a package lookup catches it.
 * That lookup is exactly what the roster runs before it offers a preset, so
 * these cases do not re-implement the judgement: they call `discoverPresets`
 * from the installed harness and read the `broken` reason it produces, with the
 * harness install as the base a row's package name resolves against. The
 * resolver is deliberately left to discovery's own default — the direct disk
 * walk that imports nothing and rejects a stale link whose package directory is
 * gone.
 *
 * The harness is located, never assumed. When none is found every case here
 * skips and the suite still runs from a bare checkout, where the offline scalar
 * guard in `../lib/index.js` remains the protection that always runs.
 */
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'
import { syncPresets } from '../lib/index.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const presetsRoot = join(packageRoot, 'presets')
const presetDir = join(presetsRoot, 'ptc-bash')
const compositionPath = join(presetDir, 'agent.cordis.yml')

/** The local files the composition mounts by relative path. */
const LOCAL_FILES = ['agent.cordis.yml', 'preset.yml', 'dsh-bash-win.mjs', 'workspace-instructions.mjs']

/** The two rows this package adds to the upstream `ptc` roster. */
const ADDED_ROWS = ['workspace-instructions', 'dsh-bash-win']

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Files to build a resolver from, in order. Each one has to sit inside the
 * installed harness: a row's package name resolves by walking up from it, so an
 * anchor outside the harness would report every package as missing.
 */
const ANCHORS = [
  process.env.DSH_PLUGIN_HOME === undefined
    ? undefined
    : join(process.env.DSH_PLUGIN_HOME, 'dsh-agent-presets', 'package.json'),
  join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
].filter((anchor) => anchor !== undefined)

/** What a usable anchor must see for this preset's own rows to read healthy. */
const VISIBLE_PACKAGES = ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-workflow-ptc']

const scratch = []
let located

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

/** The installed harness, or undefined when this machine has none. */
async function harness() {
  if (located !== undefined) return located
  for (const anchor of ANCHORS) {
    let require
    try {
      require = createRequire(anchor)
    } catch {
      continue
    }
    const sees = VISIBLE_PACKAGES.every((name) => {
      try {
        require.resolve(name + '/package.json')
        return true
      } catch {
        return false
      }
    })
    if (!sees) continue
    const presetsEntry = require.resolve('@deepseek-ai/dsh-agent-presets/package.json')
    const discovery = await import(pathToFileURL(join(presetsEntry, '..', 'lib', 'types', 'discovery.js')).href)
    located = {
      require,
      discovery,
      packageRoot: dirname(presetsEntry),
      // A directory URL: discovery walks `node_modules` upward from here.
      harnessBase: new URL('.', pathToFileURL(anchor)).href,
      shippedRoot: discovery.SHIPPED_PRESET_ROOT,
    }
    return located
  }
  return undefined
}

const MISSING_HARNESS = 'no installed harness found at: ' + ANCHORS.join(', ')

/** The loader's own YAML dialect (`!!js` included), or undefined without it. */
function dialectOf(found) {
  try {
    return { load: (text) => found.require('js-yaml').load(text, { schema: found.require('@deepseek-ai/cordis-plugin-include').entryListSchema }) }
  } catch {
    return undefined
  }
}

/**
 * The shipped `ptc` composition, wherever this install keeps it. The package's
 * own `SHIPPED_PRESET_ROOT` is derived from the module's depth, which the
 * `lib/types/` layout this harness ships resolves one directory short of the
 * bundled presets, so the package root is tried first.
 */
async function shippedPtc(found) {
  for (const candidate of [
    join(found.packageRoot, 'presets', 'ptc', 'agent.cordis.yml'),
    join(found.shippedRoot, 'ptc', 'agent.cordis.yml'),
  ]) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try the next layout
    }
  }
  return undefined
}

/** Write one preset directory (composition plus its local files) under `root`. */
async function plant(root, id, text) {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'agent.cordis.yml'), text)
  for (const file of LOCAL_FILES.filter((name) => name !== 'agent.cordis.yml')) {
    await copyFile(join(presetDir, file), join(directory, file))
  }
  return directory
}

/**
 * Rewrite one row's lines. `change` receives the row's own lines — from its
 * `- id:` line up to the next row at the same or shallower indent — and returns
 * the replacement, so a mutation cannot leak into a sibling row.
 */
function rewriteRow(text, id, change) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- id: ' + id)
  assert.notEqual(start, -1, 'row ' + id + ' is not in the composition')
  const indent = lines[start].length - lines[start].trimStart().length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trimStart().startsWith('- id:') && line.length - line.trimStart().length <= indent) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...change(lines.slice(start, end)), ...lines.slice(end)].join('\n')
}

describe('presets/ptc-bash as the harness discovery reads it', () => {
  it('is a composition the installed harness accepts', async (t) => {
    const found = await harness()
    if (found === undefined) return t.skip(MISSING_HARNESS)
    const [preset] = await found.discovery.discoverPresets([{ path: presetsRoot, trust: 'user' }], found.harnessBase)
    assert.equal(preset?.id, 'ptc-bash')
    assert.equal(preset.broken, undefined, 'harness reports: ' + preset.broken)
    assert.ok(typeof preset.name === 'string' && preset.name.length > 0, 'preset.yml publishes a display name')
  })

  it('is still accepted after the sync installs it into a discovery root', async (t) => {
    const found = await harness()
    if (found === undefined) return t.skip(MISSING_HARNESS)
    const root = await mkdtemp(join(tmpdir(), 'ptc-bash-health-'))
    scratch.push(root)
    // discovery scans one directory per preset, so the sync target is the
    // preset directory inside the scanned root — the same shape the harness
    // home's `.agent-presets/ptc-bash` has.
    const result = await syncPresets({ sourceRoot: presetDir, targetRoot: join(root, 'ptc-bash') })
    assert.deepEqual(result.failed, [])
    const [preset] = await found.discovery.discoverPresets([{ path: root, trust: 'user' }], found.harnessBase)
    assert.equal(preset?.id, 'ptc-bash')
    assert.equal(preset.broken, undefined, 'harness reports: ' + preset.broken)
  })

  it('rejects the two ways this preset actually rotted', async (t) => {
    const found = await harness()
    if (found === undefined) return t.skip(MISSING_HARNESS)
    const root = await mkdtemp(join(tmpdir(), 'ptc-bash-rot-'))
    scratch.push(root)
    const text = await readFile(compositionPath, 'utf8')

    // 0.1.5's engine package name, on a row that is enabled — the state the
    // preset was in when the mount failed with "names a plugin that cannot be
    // resolved". A disabled row is skipped by the health pass, which is why the
    // mutation has to drop `disabled: true` as well.
    const oldEngine = rewriteRow(text, 'workflow-ptc', (row) => row
      .map((line) => (line.includes("name: '@deepseek-ai/dsh-workflow-ptc'")
        ? "      name: '@deepseek-ai/dsh-workflow-worker-thread'"
        : line))
      .filter((line) => line.trim() !== 'disabled: true'))
    assert.ok(oldEngine.includes('dsh-workflow-worker-thread') && !oldEngine.includes('dsh-workflow-ptc'), 'the old-engine mutation landed')

    // The hand edit that made the file unreadable: a name scalar that opens a
    // quote and never closes it.
    const openQuote = text.replace("name: '@deepseek-ai/dsh-tool-workflow'", "name: '@deepseek-ai/dsh-tool-workflow")
    assert.notEqual(openQuote, text, 'the open-quote mutation landed')

    await plant(root, 'ptc-bash-old-engine', oldEngine)
    await plant(root, 'ptc-bash-open-quote', openQuote)
    const presets = await found.discovery.discoverPresets([{ path: root, trust: 'user' }], found.harnessBase)
    const broken = new Map(presets.map((preset) => [preset.id, preset.broken]))
    assert.equal(broken.size, 2)
    assert.match(broken.get('ptc-bash-old-engine') ?? '', /row "workflow-ptc" names a plugin that cannot be resolved: @deepseek-ai\/dsh-workflow-worker-thread/)
    assert.match(broken.get('ptc-bash-open-quote') ?? '', /not valid YAML/)
    assert.equal(broken.get('ptc-bash'), undefined, 'the real composition stays healthy beside the mutants')
  })

  it('differs from the shipped ptc preset only by the rows this package adds', async (t) => {
    const found = await harness()
    if (found === undefined) return t.skip(MISSING_HARNESS)
    const dialect = dialectOf(found)
    if (dialect === undefined) return t.skip('the installed harness exposes no js-yaml / entryListSchema')
    const upstreamPath = await shippedPtc(found)
    if (upstreamPath === undefined) return t.skip('the installed harness exposes no shipped ptc preset')
    const ours = dialect.load(await readFile(compositionPath, 'utf8'))
    const upstream = dialect.load(await readFile(upstreamPath, 'utf8'))

    const flat = (rows, prefix = '') => {
      const map = new Map()
      for (const row of rows) {
        const key = (prefix === '' ? '' : prefix + '/') + row.id
        map.set(key, row)
        if (Array.isArray(row.config)) for (const [nested, value] of flat(row.config, key)) map.set(nested, value)
      }
      return map
    }
    const mine = flat(ours)
    const theirs = flat(upstream)
    const hint = 'run `npm run derive-preset` to re-derive ptc-bash from the installed ptc preset'
    assert.deepEqual([...mine.keys()].filter((key) => !theirs.has(key)).sort(), [...ADDED_ROWS].sort(), hint)
    assert.deepEqual([...theirs.keys()].filter((key) => !mine.has(key)), [], hint)
    for (const [key, row] of mine) {
      if (!theirs.has(key)) continue
      assert.deepEqual(row, theirs.get(key), 'row ' + key + ' drifted from the shipped ptc preset — ' + hint)
    }
  })
})
