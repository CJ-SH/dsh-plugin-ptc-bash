/**
 * dsh-plugin-ptc-bash — host half: keep the harness-home user root in step with this
 * package. The roster scans `$DSH_HOME/.agent-presets` unmemoized, so a preset directory
 * that matches `presets/ptc-bash/**` byte for byte is what makes the preset selectable.
 *
 * Dependency-free (node builtins only) and idempotent: an identical tree is skipped, a
 * changed file is replaced atomically, a source file that is gone is removed from the
 * target, and a composition that does not look mountable is refused instead of written.
 * Only the `ptc-bash` directory this plugin owns is ever touched — sibling presets the
 * user authored (or the market installed) are never read, written or deleted.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-ptc-bash'

const PRESET_ID = 'ptc-bash'
const USER_PRESET_DIR = '.agent-presets'
const COMPOSITION_FILE = 'agent.cordis.yml'
const ROW_RE = /^-\s+id:\s*(.*)$/
const ROW_NAME_RE = /^ {2}name:\s*(.*)$/
const MOUNTABLE_NAME_RE = /^(\.\/|@|cordis:)/
const TEMP_PREFIX = '.tmp-'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === "'" || first === '"') && value.endsWith(first)) return value.slice(1, -1)
  }
  return value
}

/** This package's root directory. */
export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** The dsh home the roster's user root lives under. */
export function dshHome(env = process.env) {
  const configured = env?.DSH_HOME
  return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * Structural contract of a preset composition: every top-level row has a unique,
 * non-empty id and a two-space-indented mountable name. Nested config bodies stay
 * opaque — the loader checks their semantics.
 */
export function validateComposition(text) {
  const errors = []
  const seen = new Set()
  let current
  const closeRow = () => {
    if (current === undefined) return
    seen.add(current.id)
    if (current.id.length === 0) errors.push('row at line ' + current.line + ' has an empty id')
    if (current.name === undefined) errors.push('row "' + current.id + '" (line ' + current.line + ') has no two-space-indented name')
    else if (!MOUNTABLE_NAME_RE.test(current.name)) errors.push('row "' + current.id + '" name "' + current.name + '" is not a mountable specifier')
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const row = ROW_RE.exec(line)
    if (row !== null) {
      closeRow()
      const id = unquote(row[1].trim())
      if (seen.has(id)) errors.push('duplicate row id "' + id + '"')
      current = { id, name: undefined, line: index + 1 }
      continue
    }
    if (current === undefined || current.name !== undefined) continue
    const meta = ROW_NAME_RE.exec(line)
    if (meta !== null) current.name = unquote(meta[1].trim())
  }
  closeRow()
  if (seen.size === 0) errors.push('the composition has no top-level "- id:" rows')
  return errors
}

async function filesUnder(root) {
  const found = []
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
      else if (entry.isFile()) found.push(rel)
    }
  }
  await walk(root, '')
  found.sort()
  return found
}

async function sameFile(from, to) {
  const source = await stat(from).catch(() => undefined)
  if (source === undefined) return false
  const target = await stat(to).catch(() => undefined)
  if (target === undefined) return false
  if (target.size !== source.size) return false
  const [sourceBytes, targetBytes] = await Promise.all([readFile(from), readFile(to)])
  return sourceBytes.equals(targetBytes)
}

async function atomicWrite(target, bytes, counter) {
  const temp = target + TEMP_PREFIX + process.pid + '-' + counter
  await writeFile(temp, bytes, { mode: 0o600 })
  await rename(temp, target)
}

/**
 * Bring one preset directory in step with its source tree.
 * @returns copied / skipped / removed relative paths plus failed entries.
 */
export async function syncPresets(options = {}) {
  const source = resolve(options.sourceRoot ?? join(packageRoot(), 'presets', PRESET_ID))
  const target = resolve(options.targetRoot ?? join(options.home ?? dshHome(), USER_PRESET_DIR, PRESET_ID))
  const result = { source, target, copied: [], skipped: [], removed: [], failed: [] }
  const compositionPath = join(source, COMPOSITION_FILE)
  let composition
  try {
    composition = await readFile(compositionPath, 'utf8')
  } catch (error) {
    result.failed.push({ path: compositionPath, reason: 'unreadable: ' + messageOf(error) })
    return result
  }
  const problems = validateComposition(composition)
  if (problems.length > 0) {
    result.failed.push({ path: compositionPath, reason: problems.join('; ') })
    return result
  }
  const wanted = new Set(await filesUnder(source))
  await mkdir(target, { recursive: true, mode: 0o700 })
  let counter = 0
  for (const rel of wanted) {
    const from = join(source, ...rel.split('/'))
    const to = join(target, ...rel.split('/'))
    if (await sameFile(from, to)) {
      result.skipped.push(rel)
      continue
    }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    await atomicWrite(to, await readFile(from), counter)
    counter += 1
    result.copied.push(rel)
  }
  for (const rel of await filesUnder(target)) {
    if (wanted.has(rel)) continue
    await rm(join(target, ...rel.split('/')), { force: true })
    result.removed.push(rel)
  }
  return result
}

function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    // A missing logger must never turn the sync into a startup failure.
  }
}

async function runOnce(ctx) {
  try {
    const result = await syncPresets()
    if (result.failed.length > 0) {
      warn(ctx, 'dsh-plugin-ptc-bash: preset sync refused — ' + result.failed.map((entry) => entry.path + ': ' + entry.reason).join('; '))
      return
    }
    if (result.copied.length > 0 || result.removed.length > 0) {
      warn(ctx, 'dsh-plugin-ptc-bash: synced ' + result.copied.length + ' file(s), removed ' + result.removed.length + ' file(s) into ' + result.target)
    }
  } catch (error) {
    warn(ctx, 'dsh-plugin-ptc-bash: preset sync failed — ' + messageOf(error))
  }
}

/** Sync once per host start; failures warn instead of blocking the boot. */
export function apply(ctx) {
  void runOnce(ctx)
}
