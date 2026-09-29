/**
 * What the installed harness itself says about `presets/ptc-bash`.
 *
 * The failure this file exists for is one the package cannot judge alone. dsh 0.1.5
 * shipped the workflow engine as `@deepseek-ai/dsh-workflow-worker-thread`; 0.1.6
 * renamed it to `@deepseek-ai/dsh-workflow-ptc`, and a row still naming the old package
 * parses as perfectly valid YAML — only a package lookup catches it. These cases do not
 * re-implement that judgement: they run the installed registry's own checks
 * (`entryListProblem` for the row shape, the declaring plugin's `Config` schema for the
 * declaration) and then a real package lookup for every row, against the install's own
 * resolution paths.
 *
 * The install is located, never assumed, and the two ways of not finding it are told
 * apart. A machine with no dsh install at all reports a skip that says so, because there
 * is nothing here to judge. An install that IS present but does not provide the 0.2.0
 * registry FAILS: that is exactly the state this file was in when 0.2.0-rc.1 removed
 * `@deepseek-ai/dsh-agent-presets`, where the old locator found nothing, skipped four
 * authoritative cases and reported the harness as missing — the preset had already
 * vanished from the picker. `lib/index.js`'s own reader keeps the always-running half of
 * this contract (see `test/composition.test.mjs`).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { compositionRows, parseComposition, readDefinition, validateComposition } from '../lib/index.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const presetDirectory = join(packageRoot, 'presets', 'ptc-bash')
const compositionText = await readFile(join(presetDirectory, 'agent.cordis.yml'), 'utf8')

/** The two rows this package adds to the upstream `ptc` roster. */
const ADDED_ROWS = ['workspace-instructions', 'dsh-bash-win']

/** The declaring plugin and the service it registers into; both must be in the install. */
const REQUIRED = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-preset']

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Where the install's `dsh` manifest may sit, nearest first.
 *
 * Two explicit forms are accepted — `DSH_INSTALL_ROOT` as the `dsh` package root,
 * `DSH_PLUGIN_HOME` as the `@deepseek-ai` directory that holds it (what that variable
 * named before 0.2.0) — and otherwise the profile's junction decides, for whichever
 * profile directory this deployment has.
 */
async function manifests() {
  const found = []
  const add = (manifest) => {
    if (manifest !== undefined && !found.includes(manifest)) found.push(manifest)
  }
  add(process.env.DSH_INSTALL_ROOT === undefined ? undefined : join(process.env.DSH_INSTALL_ROOT, 'package.json'))
  add(process.env.DSH_PLUGIN_HOME === undefined ? undefined : join(process.env.DSH_PLUGIN_HOME, 'dsh', 'package.json'))
  const profiles = join(dshHome, 'profiles')
  const scopes = [join(profiles, 'node_modules')]
  for (const entry of await readdir(profiles, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() || entry.isSymbolicLink()) scopes.push(join(profiles, entry.name, 'node_modules'))
  }
  for (const scope of scopes) add(join(scope, '@deepseek-ai', 'dsh', 'package.json'))
  return found
}

let located

/**
 * The installed harness, or the reason there is none.
 *
 * Every candidate is resolved to its real path first: a profile keeps junctions to the
 * install, and judging the preset against a stale mirror of the packages would be the
 * same false green this file is recovering from.
 * @returns `{ skip }` when no install exists, `{ failure }` when one exists without the
 *   0.2.0 registry, otherwise the located tools.
 */
async function locate() {
  if (located !== undefined) return located
  const candidates = []
  for (const manifest of await manifests()) {
    const real = await realpath(manifest).catch(() => undefined)
    if (real !== undefined) candidates.push(real)
  }
  if (candidates.length === 0) {
    located = { skip: 'no dsh install found at: ' + (await manifests()).join(', ') + ' — set DSH_INSTALL_ROOT to the dsh package root to run the harness-judged cases' }
    return located
  }
  const failures = []
  for (const manifest of candidates) {
    const require = createRequire(manifest)
    const missing = REQUIRED.filter((name) => {
      try {
        require.resolve(name + '/package.json')
        return false
      } catch {
        return true
      }
    })
    if (missing.length > 0) {
      failures.push(manifest + ' cannot resolve ' + missing.join(' and '))
      continue
    }
    const registryEntry = require.resolve(REQUIRED[0] + '/package.json')
    const declaringEntry = require.resolve(REQUIRED[1] + '/package.json')
    const appBootEntry = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
    const installed = {
      manifest,
      require,
      // Both are the packages' own entry points, so the checks below are the harness's
      // judgement and not a second implementation of it.
      registry: await import(pathToFileURL(join(dirname(registryEntry), 'lib', 'index.js')).href),
      declaring: (await import(pathToFileURL(join(dirname(declaringEntry), 'lib', 'index.js')).href)).default,
      // The startup compatibility gate, available offline: the same function the profile
      // preflight runs before a row is admitted.
      appBoot: await import(pathToFileURL(join(dirname(appBootEntry), 'lib', 'index.js')).href),
      dialect: {
        load: (text) => require('js-yaml').load(text, { schema: require('@deepseek-ai/cordis-plugin-include').entryListSchema }),
      },
    }
    located = installed
    return located
  }
  located = { failure: 'a dsh install is present but provides no 0.2.0 preset registry: ' + failures.join('; ') }
  return located
}

/** The located tools, or a failed/skipped case that explains itself. */
async function harness(t) {
  const found = await locate()
  if (found.failure !== undefined) assert.fail(found.failure)
  if (found.skip !== undefined) {
    t.skip(found.skip)
    return undefined
  }
  return found
}

/** The bare package a row's specifier starts with, or undefined when it names none. */
function bareName(specifier) {
  const match = /^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/|$)/.exec(specifier)
  return match === null ? undefined : match[1]
}

/** Why one row's `name` does not name anything this install can import. */
function moduleProblem(name, installed) {
  if (typeof name !== 'string' || name === '') return 'names no plugin'
  if (name.startsWith('cordis:')) return undefined
  if (name.startsWith('file:')) {
    const file = fileURLToPath(name)
    return existsSync(file) ? undefined : 'names no file: ' + file
  }
  const bare = bareName(name)
  if (bare === undefined) return 'is neither a package nor a file URL: ' + name
  for (const directory of installed.require.resolve.paths(bare) ?? []) {
    if (existsSync(join(directory, ...bare.split('/'), 'package.json'))) return undefined
  }
  return 'names a plugin that cannot be resolved: ' + name
}

/**
 * Every way a registered composition can be unusable, in the installed harness's terms.
 *
 * `entryListProblem` validates shape only — the registry says so itself and its own mount
 * audit is what resolves packages — so the lookup below is the other half. It runs on
 * every row whether or not the row is disabled: the rename that started this file was on
 * a row that ships disabled, and a name that cannot resolve is a defect the day its gate
 * opens.
 * @param rows Rows as they would reach `ctx.agentPresets.register`.
 * @param installed Located install tools.
 * @returns One line per problem; empty when the declaration is sound.
 */
function rowProblems(rows, installed) {
  const problems = []
  const shape = installed.registry.entryListProblem(rows)
  if (shape !== undefined) problems.push(shape)
  const walk = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      if (row.group === true && Array.isArray(row.config)) {
        walk(row.config)
        continue
      }
      const problem = moduleProblem(row.name, installed)
      if (problem !== undefined) problems.push('row "' + String(row.id) + '" ' + problem)
    }
  }
  walk(rows)
  return problems
}

/** The same rows with one id's `name` replaced, nested groups included. */
function renameRow(rows, id, name) {
  return rows.map((row) => {
    if (row.id === id) return { ...row, name }
    if (row.group === true && Array.isArray(row.config)) return { ...row, config: renameRow(row.config, id, name) }
    return row
  })
}

/** One preset roster flattened to `<parent>/<id>` keys, group rows included. */
function flatten(rows, prefix = '') {
  const map = new Map()
  for (const row of rows) {
    const key = (prefix === '' ? '' : prefix + '/') + row.id
    map.set(key, row)
    if (Array.isArray(row.config)) for (const [nested, value] of flatten(row.config, key)) map.set(nested, value)
  }
  return map
}

describe('presets/ptc-bash as the installed harness reads it', () => {
  it('is a row list the installed loader dialect and registry both accept', async (t) => {
    const found = await harness(t)
    if (found === undefined) return
    // The package's own reader against the loader's own dialect, row by row: this is what
    // makes the reader in lib/index.js trustworthy for the file that ships.
    assert.deepEqual(parseComposition(compositionText), found.dialect.load(compositionText))
    assert.equal(found.registry.entryListProblem(parseComposition(compositionText)), undefined)
    // And the declaration the plugin actually publishes, through the declaring plugin's
    // own schema — the check that runs at activation.
    const definition = await readDefinition()
    const validated = found.declaring.Config(definition)
    assert.equal(validated.id, 'ptc-bash')
    assert.deepEqual(validated.plugins, definition.plugins)
    assert.deepEqual(validateComposition(compositionText), [])
  })

  it('is a declaration whose every row the install can really import', async (t) => {
    const found = await harness(t)
    if (found === undefined) return
    const rows = (await readDefinition()).plugins
    assert.equal(found.registry.entryListProblem(rows), undefined)
    // The two local rows are file URLs into this package, which is what the registry's
    // DECLARING-loader base requires; `moduleProblem` is where that is checked.
    assert.deepEqual(rows.filter((row) => row.name.startsWith('file:')).map((row) => row.id), ADDED_ROWS)
    assert.deepEqual(rowProblems(rows, found), [])
    // The registry hands these rows to `prepareProfileEntries`, which clones them before
    // the Loader sees them. `!!js` nodes and file URLs are exactly the values a clone can
    // lose, so the rows are run through that same call here — with a context carrying no
    // profile facts, which is the clone without the compatibility preflight.
    const base = pathToFileURL(join(presetDirectory, 'agent.cordis.yml')).href
    assert.deepEqual(found.appBoot.prepareProfileEntries({ get: () => undefined }, rows, base), rows)
  })

  it('turns red for a row naming a package, or a file, that is not there', async (t) => {
    const found = await harness(t)
    if (found === undefined) return
    const rows = (await readDefinition()).plugins
    assert.deepEqual(rowProblems(rows, found), [], 'the shipped declaration is the control')

    // The rename that broke this preset in 0.1.6, on the row that carried it.
    const removed = renameRow(rows, 'workflow-ptc', '@deepseek-ai/dsh-agent-presets')
    assert.match(
      rowProblems(removed, found).join('\n'),
      /row "workflow-ptc" names a plugin that cannot be resolved: @deepseek-ai\/dsh-agent-presets/,
    )

    // A local row whose file is gone: the failure the file-URL rewrite can produce.
    const broken = compositionText.replace('name: ./dsh-bash-win.mjs', 'name: ./missing.mjs')
    assert.notEqual(broken, compositionText, 'the mutation landed')
    const local = compositionRows(parseComposition(broken), presetDirectory)
    assert.match(rowProblems(local, found).join('\n'), /row "dsh-bash-win" names no file: .*missing\.mjs/)

    // And the shape half, which the registry owns: a row without a name.
    assert.match(found.registry.entryListProblem([{ id: 'x' }]) ?? '', /row 1 names no plugin/)
  })

  it('declares a peer range the installed runtime admits', async (t) => {
    const found = await harness(t)
    if (found === undefined) return
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    // The runtime's own gate, run here instead of at the next restart: only
    // `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are checked, prereleases
    // participate in the range, and an incompatible range denies this row at startup.
    assert.equal(found.appBoot.evaluatePluginCompatibility(manifest), undefined)
    // Proof that the gate is really being asked, and not answering green for everything.
    const wrong = { ...manifest, peerDependencies: { '@deepseek-ai/dsh': '^0.1.5-rc.1' } }
    assert.deepEqual(found.appBoot.evaluatePluginCompatibility(wrong)?.peers, { '@deepseek-ai/dsh': '^0.1.5-rc.1' })
    // A manifest that declares no peer at all is admitted silently, which is exactly why
    // the range above is the only thing between an incompatible upgrade and a dead row.
    const undeclared = { ...manifest }
    delete undeclared.peerDependencies
    assert.equal(found.appBoot.evaluatePluginCompatibility(undeclared), undefined)
  })

  it('differs from the shipped ptc preset only by the rows this package adds', async (t) => {
    const found = await harness(t)
    if (found === undefined) return
    const webApp = (() => {
      try {
        return found.require.resolve('@deepseek-ai/dsh-web-app/package.json')
      } catch {
        return undefined
      }
    })()
    if (webApp === undefined) {
      t.skip('this install ships no @deepseek-ai/dsh-web-app, so the upstream ptc preset is not here to compare')
      return
    }
    const patchPath = join(dirname(webApp), 'presets', 'ptc.patch.yml')
    if (!existsSync(patchPath)) assert.fail('the shipped ptc preset moved: ' + patchPath + ' does not exist')
    // 0.2.0 ships the preset as a loader patch instead of a preset directory; the rows are
    // the same list in a different place, which is why the comparison below is unchanged.
    const upstream = found.dialect.load(await readFile(patchPath, 'utf8'))[0].insert[0].config.plugins

    const mine = flatten(parseComposition(compositionText))
    const theirs = flatten(upstream)
    const hint = 'run `npm run derive-preset` to re-derive ptc-bash from the installed ptc preset'
    assert.deepEqual([...mine.keys()].filter((key) => !theirs.has(key)).sort(), [...ADDED_ROWS].sort(), hint)
    assert.deepEqual([...theirs.keys()].filter((key) => !mine.has(key)), [], hint)
    for (const [key, row] of mine) {
      if (!theirs.has(key)) continue
      assert.deepEqual(row, theirs.get(key), 'row ' + key + ' drifted from the shipped ptc preset — ' + hint)
    }
  })
})
