/**
 * dsh-plugin-ptc-bash — host half: publish this package's agent preset.
 *
 * dsh 0.2.0-rc.1 removed preset discovery from disk: nothing scans
 * `$DSH_HOME/.agent-presets` any more (the 0.1.x roster root), and `preset.yml` /
 * `agent.cordis.yml` are read by no one on their own. A preset now exists because a
 * plugin row hands its rows to `ctx.agentPresets.register(definition)`, which is what
 * this half does on activation, from the two files the package ships.
 *
 * The registry mounts a declaration under the DECLARING loader's resolution base, so the
 * two rows living beside the composition (`./dsh-bash-win.mjs`,
 * `./workspace-instructions.mjs`) are published as file URLs: a `./` row would otherwise
 * be resolved against the profile, not against this package.
 *
 * Dependency-free (node builtins only), like the composition it publishes: a host half in
 * this workspace imports no harness package, so the reader below is this package's own
 * rather than a YAML dependency. It covers the dialect this derived file uses and throws
 * on everything else — `test/composition-health.test.mjs` parses the same file with the
 * installed loader's own dialect (`js-yaml` + `entryListSchema`) and compares the two row
 * by row, so a construct the reader mis-reads fails the suite instead of a session.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-plugin-ptc-bash'

/**
 * The registry that owns preset registration. Declared as a dependency rather than read
 * opportunistically, so a profile composed without
 * `@deepseek-ai/dsh-agent-preset-registry` leaves this row INACTIVE instead of throwing
 * on activation.
 */
export const inject = ['agentPresets']

const PRESET_ID = 'ptc-bash'
const COMPOSITION_FILE = 'agent.cordis.yml'
const META_FILE = 'preset.yml'

/** A row's `name` is a module specifier the loader can import. */
const MOUNTABLE_RE = /^(?:\.{1,2}[\\/]|file:|@|cordis:|[\\/]|[A-Za-z]:[\\/])/

/** A row that points at a file beside the composition rather than at a package. */
const RELATIVE_RE = /^\.{1,2}[\\/]/

const JS_TAG = '!!js'
const BLOCK_HEADER_RE = /^[|>][+-]?$/
const MAPPING_RE = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/
const SEQUENCE_RE = /^-([ \t]+(.*))?$/
const DISPLAY_FIELDS = [['name', 'string'], ['description', 'string'], ['order', 'number']]

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drop a trailing `# …` comment, leaving quoted text alone.
 *
 * A `#` only opens a comment at the start of a scalar or after whitespace, and never
 * inside one — the difference between `tool: bash  # preferred` and a URL or a shell
 * fragment carrying a `#`.
 */
function stripComment(text) {
  let quote
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (quote === '"' && char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index)
  }
  return text
}

/** Whether a sequence item's own text continues as a block mapping (`- id: x`). */
function isMappingStart(text) {
  return MAPPING_RE.test(stripComment(text).trim())
}

/** A quoted scalar, with the escape forms the composition dialect admits. */
function readQuoted(body, quote, line) {
  if (body.length < 2 || !body.endsWith(quote)) {
    throw new Error('line ' + line + ': a ' + (quote === "'" ? 'single' : 'double') + '-quoted scalar never closes')
  }
  const inner = body.slice(1, -1)
  if (quote === "'") return inner.split("''").join("'")
  return inner
    .replace(/\\(["\\/bfnrt])/g, (_, code) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[code])
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * One scalar node.
 *
 * `!!js` becomes the `{ __jsExpr }` node the loader evaluates (`isJsExpr` reads exactly
 * that shape) — a plain object, which is also what the shipped dialect produces, so an
 * expression survives `structuredClone` on its way to the preset mount. Plain scalars
 * follow `JSON_SCHEMA`: `true` / `false` / `null` / numbers, everything else stays text.
 */
function readScalar(text, line) {
  const body = text.trim()
  if (body.startsWith(JS_TAG)) {
    const expression = stripComment(body.slice(JS_TAG.length)).trim()
    if (expression === '') throw new Error('line ' + line + ': a ' + JS_TAG + ' tag needs an expression')
    return { __jsExpr: expression }
  }
  if (body === '') return null
  const quote = body[0]
  if (quote === "'" || quote === '"') return readQuoted(body, quote, line)
  if (body === 'true' || body === 'false') return body === 'true'
  if (body === 'null') return null
  if (/^[&*!{}[\]]/.test(body)) throw new Error('line ' + line + ': anchors, aliases, tags and flow collections are not supported')
  if (/^-?(?:0|[1-9]\d*)$/.test(body) || /^-?(?:0|[1-9]\d*)\.\d+(?:[eE][-+]?\d+)?$/.test(body)) return Number(body)
  return body
}

/**
 * Read one YAML document out of this package's own files.
 *
 * Deliberately a subset — block mappings, block sequences, `!!js` tags, quoted and plain
 * scalars, literal/folded block scalars, comments — and deliberately loud: an anchor, an
 * alias, a flow collection, a document marker or an unexpected indentation throws with
 * its line number. Silently dropping a row is the failure this whole package exists to
 * catch, so the reader must never guess.
 * @param text Document source.
 * @returns The parsed document.
 */
export function parseYaml(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const indentOf = (line) => line.length - line.trimStart().length
  /**
   * One past the last line a block scalar starting at `node` carries.
   *
   * Its content is text, not structure: `#` lines and `- id: x` lines inside it must be
   * left for the scalar reader instead of being queued as nodes.
   */
  const blockEnd = (node) => {
    let index = node.raw + 1
    for (; index < raw.length; index += 1) {
      const line = raw[index]
      if (line.trim() === '') continue
      if (indentOf(line) <= node.indent) break
    }
    return index
  }

  const nodes = []
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '---' || trimmed === '...') throw new Error('line ' + (index + 1) + ': document markers are not supported')
    const indent = indentOf(line)
    const body = line.slice(indent)
    const item = SEQUENCE_RE.exec(body)
    if (item !== null) {
      const inline = item[2] === undefined ? '' : stripComment(item[2]).trim()
      if (BLOCK_HEADER_RE.test(inline)) throw new Error('line ' + (index + 1) + ': a block scalar as a list item is not supported')
      nodes.push({ indent, item: true, inline, line: index + 1, raw: index })
      if (inline !== '' && isMappingStart(inline)) {
        // `- id: x` continues on the following lines at the item's own key indent, so the
        // item's first pair becomes a mapping node of its own.
        const offset = 1 + item[1].length - item[2].length
        const pair = MAPPING_RE.exec(inline)
        nodes.push({ indent: indent + offset, key: pair[1], value: pair[2], line: index + 1, raw: index })
      }
      continue
    }
    const mapping = MAPPING_RE.exec(stripComment(body).trim())
    if (mapping === null) throw new Error('line ' + (index + 1) + ': not a "key: value" entry or a "- " item (this reader supports no other construct)')
    const node = { indent, key: mapping[1], value: mapping[2], line: index + 1, raw: index }
    nodes.push(node)
    if (node.value !== undefined && BLOCK_HEADER_RE.test(node.value.trim())) index = blockEnd(node) - 1
  }

  const cursor = { index: 0 }

  const readBlockScalar = (node) => {
    const style = node.value[0]
    const chomp = node.value.slice(1)
    const lines = []
    let contentIndent
    for (let index = node.raw + 1; index < raw.length; index += 1) {
      const line = raw[index]
      if (line.trim() === '') {
        lines.push('')
        continue
      }
      const indent = indentOf(line)
      if (indent <= node.indent) break
      if (contentIndent === undefined) contentIndent = indent
      else if (indent < contentIndent) throw new Error('line ' + (index + 1) + ': this block scalar is indented less than its first line')
      lines.push(line.slice(contentIndent))
    }
    let breaks = 0
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
      breaks += 1
    }
    const folded = style === '|' ? lines.join('\n') : foldLines(lines)
    if (chomp === '-') return folded
    return folded + '\n'.repeat(chomp === '+' ? breaks + 1 : 1)
  }

  const readNode = (minIndent) => {
    const node = nodes[cursor.index]
    if (node === undefined || node.indent < minIndent) return null
    if (node.item === true) return readSequence(node.indent)
    if (node.key === undefined) throw new Error('line ' + node.line + ': expected a row mapping')
    return readMapping(node.indent)
  }

  const readSequence = (indent) => {
    const items = []
    while (cursor.index < nodes.length) {
      const node = nodes[cursor.index]
      if (node.indent !== indent || node.item !== true) break
      cursor.index += 1
      // An item that continues as a mapping already queued its own node at the item's key
      // indent, so both forms are read as the next deeper node.
      if (node.inline === '' || isMappingStart(node.inline)) items.push(readNode(indent + 1))
      else items.push(readScalar(node.inline, node.line))
    }
    return items
  }

  const readMapping = (indent) => {
    const value = {}
    while (cursor.index < nodes.length) {
      const node = nodes[cursor.index]
      if (node.indent !== indent || node.item === true) break
      if (Object.hasOwn(value, node.key)) throw new Error('line ' + node.line + ': duplicate key "' + node.key + '"')
      cursor.index += 1
      if (node.value === undefined) value[node.key] = readNode(indent + 1)
      else if (BLOCK_HEADER_RE.test(node.value.trim())) value[node.key] = readBlockScalar(node)
      else value[node.key] = readScalar(node.value, node.line)
    }
    return value
  }

  const document = readNode(0)
  if (cursor.index < nodes.length) throw new Error('line ' + nodes[cursor.index].line + ': unexpected indentation')
  return document
}

/** A folded scalar joins adjacent lines with one space and keeps a blank line as a break. */
function foldLines(lines) {
  return lines.reduce((text, line) => {
    if (line === '') return text + '\n'
    if (text === '' || text.endsWith('\n')) return text + line
    return text + ' ' + line
  }, '')
}

/**
 * The rows of one preset composition.
 * @param text Composition source.
 * @returns Top-level plugin rows.
 */
export function parseComposition(text) {
  const rows = parseYaml(text)
  if (!Array.isArray(rows)) throw new Error('the composition must be a top-level list of plugin rows')
  return rows
}

/**
 * Structural contract of a composition, read from the parsed document rather than from
 * its text.
 *
 * This is the offline half of the guard — it needs no installed harness and always runs.
 * It deliberately does NOT judge package names: only the loader's own package lookup can
 * tell whether `@deepseek-ai/dsh-persona` still exists, so that judgement is left to the
 * installed registry (`entryListProblem` for the shape, the mount audit for the rows) and
 * to `test/composition-health.test.mjs`, which owns the install-root lookup. A string
 * comparison here would answer green for exactly the renamed package this guard exists
 * for.
 * @param text Composition source.
 * @returns One line per problem; empty when the composition is a mountable row list.
 */
export function validateComposition(text) {
  let rows
  try {
    rows = parseComposition(text)
  } catch (error) {
    return [messageOf(error)]
  }
  const problems = []
  const seen = new Set()
  const check = (list) => {
    if (list.length === 0) problems.push('the composition has no rows')
    for (const row of list) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        problems.push('a row is not a mapping')
        continue
      }
      const id = row.id
      if (typeof id !== 'string' || id === '') problems.push('a row has no id')
      else if (seen.has(id)) problems.push('duplicate row id "' + id + '"')
      else seen.add(id)
      if (typeof row.name !== 'string' || row.name === '') problems.push('row "' + String(id) + '" has no name')
      else if (!MOUNTABLE_RE.test(row.name)) problems.push('row "' + String(id) + '" name "' + row.name + '" is not a mountable specifier')
      if (row.group === true) {
        if (!Array.isArray(row.config)) problems.push('group row "' + String(id) + '" has no child row list')
        else check(row.config)
      }
    }
  }
  check(rows)
  return problems
}

/**
 * Rewrite one row list's `./x.mjs` names into file URLs under `directory`.
 *
 * The registry mounts a declaration under the declaring loader's base, which is the
 * profile — not this package — so a relative row left as written would import from the
 * wrong directory.
 * @param rows Parsed composition rows.
 * @param directory Directory the composition was read from.
 * @returns Rows ready for `register`, nested group rows included.
 */
export function compositionRows(rows, directory) {
  return rows.map((row) => {
    const copy = { ...row }
    if (typeof copy.name === 'string' && RELATIVE_RE.test(copy.name)) {
      copy.name = pathToFileURL(resolve(directory, copy.name)).href
    }
    if (Array.isArray(copy.config)) copy.config = compositionRows(copy.config, directory)
    return copy
  })
}

/** This package's root directory. */
export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * The declaration this package registers, read from the files it ships.
 *
 * `id` is this package's fixed identity — the registry refuses a duplicate loudly, and a
 * preset whose id came from a file could be renamed out from under a selection. Display
 * fields stay in `preset.yml` so the preset's identity and its presentation keep one
 * source each.
 * @param root Package root; the default is this module's own package.
 * @returns A definition for `ctx.agentPresets.register`.
 */
export async function readDefinition(root = packageRoot()) {
  const directory = join(root, 'presets', PRESET_ID)
  const [metaText, compositionText] = await Promise.all([
    readFile(join(directory, META_FILE), 'utf8'),
    readFile(join(directory, COMPOSITION_FILE), 'utf8'),
  ])
  const meta = parseYaml(metaText)
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(META_FILE + ': expected a mapping of display fields')
  }
  const definition = { id: PRESET_ID, plugins: compositionRows(parseComposition(compositionText), directory) }
  for (const [field, type] of DISPLAY_FIELDS) {
    if (meta[field] === undefined) continue
    if (typeof meta[field] !== type) throw new Error(META_FILE + ': ' + field + ' must be a ' + type)
    definition[field] = meta[field]
  }
  return definition
}

function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    // A missing logger must never turn registration into an activation failure.
  }
}

/**
 * Register this package's preset with the host registry.
 *
 * Awaited, so a declaration the registry refuses is reported before the row settles, and
 * wrapped, because nothing here may throw: a throwing row is how this plugin family goes
 * silent (0.2.0 fails one row and writes one stderr line), and a mount the registry
 * records as broken is already visible in the roster through `AgentPreset.broken` —
 * logging it again is enough.
 * @param ctx Row context carrying the `agentPresets` service.
 */
export async function apply(ctx) {
  try {
    const dispose = await ctx.agentPresets.register(await readDefinition())
    // The declaring plugin owns the registration: without this a reload would leave the
    // definition behind and the next activation would be refused as a duplicate.
    if (typeof dispose !== 'function') return
    ctx.effect(() => () => {
      try {
        const result = dispose()
        if (result instanceof Promise) result.catch(() => {})
      } catch {
        // Disposal must not fail the row's teardown.
      }
    })
  } catch (error) {
    warn(ctx, 'dsh-plugin-ptc-bash: preset registration failed — ' + messageOf(error))
  }
}
