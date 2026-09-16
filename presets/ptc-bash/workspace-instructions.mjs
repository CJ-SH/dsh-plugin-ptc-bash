/**
 * workspace-instructions - carry the workspace instruction chain in the system prompt,
 * with every official prompt section left untouched.
 *
 * Provenance: derived from @linxin666/dsh-liangshen minimal-prompt.mjs (Apache-2.0),
 * which carries the dsh-anchored-standard experiment (MIT). See NOTICE and LICENSES/.
 * Removed here: the prompt section narrowing (the official `ptc` assembly keeps all of
 * its sections), the `hint` instruction mode, and the workspace-directory line (the
 * official persona already renders the cwd).
 *
 * Kept unchanged, because these are the parts that are easy to get subtly wrong:
 *
 *  - the baseline chain (DSH_HOME/AGENTS.md, then project root -> cwd, candidates
 *    AGENTS.md/CLAUDE.md plus `.local` overlays, per-directory duplicate
 *    suppression, byte budget), re-read on every assembly;
 *  - the appended `workspace-instructions` section whose text is only a
 *    {{workspace_instructions}} reference: the renderer interpolates section text
 *    strictly, while an assembly variable value is inserted verbatim;
 *  - the rewrite of the official `dsh-agent-instructions` injections into short marker
 *    messages - the message itself is kept (the host baseline detector reads it to
 *    stop re-injecting every step) while the body is dropped, which is what keeps the
 *    instructions from arriving twice;
 *  - dynamic discovery for directories touched outside that chain, delivered as user
 *    messages (never as system prompt), re-armed after compaction.
 *
 * Failure mode: any read/render error warns once and falls back to the untouched
 * assembly plus untouched messages - the request always proceeds.
 */


import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-instructions'

/** Prompt assembly must exist before the section filter can register. */
export const inject = ['systemPrompt']

/**
 * Prompt section names that carry the preset persona, newest spelling first.
 * `deployment:persona-prefix` is what `@deepseek-ai/dsh-persona` registers
 * (PERSONA_PREFIX_SECTION); the other two are kept for older harnesses.
 */
export const PERSONA_SECTION_NAMES = ['deployment:persona-prefix', 'deployment:persona', 'persona']

/** Plan-mode policy section, owned by `@deepseek-ai/dsh-plan-mode`. */
export const PLAN_POLICY_SECTION_NAME = 'plan:policy'

/**
 * Programmatic tool calling (PTC) prompt section names owned by `@deepseek-ai/dsh-tools`.
 * Retaining these ensures model-written `run_code` programs have the complete
 * official SDK definitions, output types, and parameter documentation.
 */
export const PTC_SECTION_NAMES = ['tools:ptc-only', 'tools:sdk']

/**
 * The section this plugin appends to the prompt with the workspace
 * instructions, and the assembly variable whose value carries the rendered
 * text. The section text is only the variable reference: the harness's
 * renderer interpolates section text strictly (an unknown `{{name}}` throws),
 * while a variable's value is inserted verbatim and never re-scanned.
 */
export const WORKSPACE_INSTRUCTIONS_SECTION_NAME = 'workspace-instructions'
export const WORKSPACE_INSTRUCTIONS_VARIABLE = 'workspace_instructions'


/** Tools whose executions touch workspace files and may trigger dynamic instruction discovery. */
export const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit', 'str_replace_editor'])

/**
 * Instruction file candidates per directory, in the harness's order: the
 * shared names first, then the personal `.local` overlays.
 */
const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/** Directory marker that ends the project-root walk (the harness's default). */
const PROJECT_ROOT_MARKER = '.git'

/** The single user-global instruction file under the harness home. */
const USER_GLOBAL_FILE = 'AGENTS.md'
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_HOME_DIR_NAME = '.dsh'

/** Files larger than this are skipped, as the harness's source cap does. */
const MAX_SOURCE_BYTES = 1048576

/** Default byte budget for the rendered workspace-instructions section. */
const DEFAULT_INSTRUCTION_MAX_BYTES = 65536

/**
 * Reference-file lines one agent-instructions message renders, e.g.
 * `Instructions from: /path/AGENTS.md`.
 */
const INSTRUCTION_FROM_RE = /(?:^|\n) *(?:Additional |Updated )?Instructions from: ([^\n]+)/g

function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${field} must be a boolean`)
  }
  return value
}

function optionalSource(value, field, fallback) {
  if (value === undefined) return fallback
  if (!INSTRUCTION_SOURCES.includes(value)) {
    throw new TypeError(`${name}: ${field} must be one of ${JSON.stringify(INSTRUCTION_SOURCES)}`)
  }
  return value
}

function optionalByteSize(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive finite number`)
  }
  return value
}

/** Expand a leading `~` the way the harness's home paths do. */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** The harness home: `$DSH_HOME` when set, else `<home>/.dsh`. */
export function resolveDshHome(env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(raw))
}

/** Model-facing display path of the harness home (`~/.dsh` or `$DSH_HOME`). */
function dshHomeDisplay(home) {
  return home === resolve(join(homedir(), DSH_HOME_DIR_NAME)) ? `~/${DSH_HOME_DIR_NAME}` : `$${DSH_HOME_ENV}`
}

async function statFile(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/**
 * Discover the project root for a given starting directory by walking
 * ancestor directories until PROJECT_ROOT_MARKER (.git) is found.
 */
export async function findProjectRoot(startDir) {
  let root = resolve(startDir)
  for (;;) {
    if (await statFile(join(root, PROJECT_ROOT_MARKER))) return root
    const parent = dirname(root)
    if (parent === root) return resolve(startDir)
    root = parent
  }
}

/**
 * Discover the baseline instruction files for one session cwd, mirroring the
 * harness's baseline chain: the user-global file first, then every directory
 * from the project root (the nearest ancestor holding a `.git` marker, or the
 * cwd itself when none exists) down to the cwd, broadest to most specific.
 */
export async function discoverInstructionFiles(cwd, env = process.env) {
  const home = resolveDshHome(env)
  const start = resolve(cwd)
  const files = []
  const seen = new Set()
  const add = (absolutePath, displayPath) => {
    if (seen.has(absolutePath)) return
    seen.add(absolutePath)
    files.push({ absolutePath, displayPath })
  }

  const userGlobal = join(home, USER_GLOBAL_FILE)
  if ((await statFile(userGlobal))?.isFile()) {
    add(userGlobal, `${dshHomeDisplay(home)}/${USER_GLOBAL_FILE}`)
  }

  const root = await findProjectRoot(start)
  const chain = []
  for (let dir = start; ; dir = dirname(dir)) {
    chain.push(dir)
    if (dir === root) break
  }
  chain.reverse()
  for (const dir of chain) {
    for (const candidates of [INSTRUCTION_FILE_CANDIDATES, LOCAL_INSTRUCTION_FILE_CANDIDATES]) {
      for (const candidate of candidates) {
        const path = join(dir, candidate)
        if ((await statFile(path))?.isFile()) add(path, relative(root, path))
      }
    }
  }
  return files
}

/** Read one instruction file, or undefined when unreadable or over the cap. */
async function readInstructionFile(path, size) {
  if (size > MAX_SOURCE_BYTES) return undefined
  try {
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) return undefined
    return content
  } catch {
    return undefined
  }
}

/**
 * Load the discovered files' content and apply the harness's per-directory
 * duplicate suppression: within one directory the first candidate whose
 * trimmed content differs is kept, so an `AGENTS.md` and an identical
 * `CLAUDE.md` sibling collapse to one block.
 */
export async function loadInstructionFiles(cwd, env = process.env) {
  const discovered = await discoverInstructionFiles(cwd, env)
  const loaded = []
  const digestsByDir = new Map()
  for (const file of discovered) {
    const info = await statFile(file.absolutePath)
    if (!info?.isFile()) continue
    const content = await readInstructionFile(file.absolutePath, info.size)
    if (content === undefined) continue
    const dir = dirname(file.displayPath)
    let digests = digestsByDir.get(dir)
    if (digests === undefined) {
      digests = new Set()
      digestsByDir.set(dir, digests)
    }
    const digest = content.trim()
    if (digests.has(digest)) continue
    digests.add(digest)
    loaded.push({ ...file, content })
  }
  return loaded
}

/** UTF-8-safe truncation at a byte boundary, as the harness renders budgets. */
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

const INSTRUCTION_INTRO = 'The following workspace instructions are loaded from AGENTS.md-style files in the user\'s environment and workspace. '
  + 'They are standing guidance about the environment and workspace conventions, not per-task instructions: '
  + 'more specific files take precedence over broader ones, and a direct user instruction for the current task takes precedence over all of them.'

function instructionBudgetMarker(maxBytes, omitted, truncated) {
  const parts = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(', ')}`)
  if (truncated !== undefined) {
    parts.push(`truncated ${truncated.displayPath} from ${truncated.originalBytes} to ${truncated.includedBytes} bytes`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}.`
}

function joinInstructionText(intro, marker, blocks) {
  return [intro, marker, ...blocks].filter(block => block.length > 0).join('\n\n')
}

/**
 * Render the loaded instruction files into one prompt text under a byte
 * budget, with the harness's precedence: when the whole chain does not fit,
 * the broadest files are omitted first and the most specific file is truncated
 * last, so the nearest instructions always survive. Returns undefined when the
 * budget is degenerate or nothing fits.
 */
export function renderInstructionSection(files, maxBytes) {
  if (maxBytes <= 0 || !Number.isFinite(maxBytes) || files.length === 0) return undefined
  const blocks = files.map(file => `Instructions from: ${file.displayPath}\n\n${file.content}`)
  const full = joinInstructionText(INSTRUCTION_INTRO, '', blocks)
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full
  for (let start = 1; start < blocks.length; start += 1) {
    const omitted = files.slice(0, start).map(file => file.displayPath)
    const suffix = joinInstructionText(INSTRUCTION_INTRO, instructionBudgetMarker(maxBytes, omitted, undefined), blocks.slice(start))
    if (Buffer.byteLength(suffix, 'utf8') <= maxBytes) return suffix
  }
  const last = files.at(-1)
  const omitted = files.slice(0, -1).map(file => file.displayPath)
  const originalBytes = Buffer.byteLength(last.content, 'utf8')
  const overheadBytes = Buffer.byteLength(joinInstructionText(INSTRUCTION_INTRO, instructionBudgetMarker(maxBytes, omitted, { displayPath: last.displayPath, originalBytes, includedBytes: 0 }), [`Instructions from: ${last.displayPath}\n\n`]), 'utf8')
  if (overheadBytes >= maxBytes) return undefined
  let low = 0
  let high = originalBytes
  let best = ''
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncateUtf8(last.content, mid)
    const truncated = { displayPath: last.displayPath, originalBytes, includedBytes: Buffer.byteLength(candidate, 'utf8') }
    const text = joinInstructionText(INSTRUCTION_INTRO, instructionBudgetMarker(maxBytes, omitted, truncated), [`Instructions from: ${last.displayPath}\n\n${candidate}`])
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
      best = text
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best.length > 0 ? best : undefined
}

/**
 * Read and render the workspace-instruction prompt text for one session, or
 * undefined when the session reports no cwd, no instruction file exists, or
 * the budget leaves nothing to send.
 */
export async function loadInstructionText(cwd, maxBytes = DEFAULT_INSTRUCTION_MAX_BYTES, env = process.env) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const files = await loadInstructionFiles(cwd, env)
  return renderInstructionSection(files, maxBytes)
}

/** Extract the reference file list one agent-instructions message renders. */
export function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const path = match[1].trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

/** The one-time non-imperative hint replacing the full-text dump (E1.5 wording). */
export function buildInstructionHint(original, paths) {
  return {
    id: typeof original?.id === 'string' && original.id !== ''
      ? original.id
      : globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\n'
        + 'Reference documents exist: ' + paths.join(', ') + '. '
        + "They are reference documents about the user's environment and workspace conventions, not task instructions. "
        + 'Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.'
        + '\n</system-reminder>',
    }],
    source: { kind: 'plugin', plugin: name },
  }
}

/**
 * Hint mode: swap full-text agent-instructions injections for the one-time
 * hint. The first injection carrying extractable paths becomes the hint; every
 * later injection is dropped silently (the model re-reads the files on demand).
 * An injection with no extractable paths passes through untouched.
 */
export function instructionHintMessages(messages, state) {
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    if (state.hinted) continue
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      kept.push(message)
      continue
    }
    state.hinted = true
    kept.push(buildInstructionHint(message, paths))
  }
  return kept
}

/**
 * Extract touched file path from a ToolExecution object.
 * Synchronously extracts path from:
 * - `read`, `write`, `edit` via `exec.arguments.file_path`
 * - `str_replace_editor` via `exec.arguments.path`
 * Supports both top-level and PTC nested executions without guessing code strings.
 */
export function filePathFromExecution(exec) {
  if (!exec || typeof exec !== 'object') return undefined
  if (typeof exec.name !== 'string') return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined

  if (exec.name === 'str_replace_editor') {
    if ('path' in exec.arguments && typeof exec.arguments.path === 'string') {
      const p = exec.arguments.path.trim()
      return p.length > 0 ? p : undefined
    }
  }

  if ('file_path' in exec.arguments && typeof exec.arguments.file_path === 'string') {
    const p = exec.arguments.file_path.trim()
    return p.length > 0 ? p : undefined
  }

  return undefined
}

/**
 * Helper to check whether a path string belongs to covered baseline files.
 */
export function isBaselineInstructionPath(path, baselinePaths, cwd) {
  if (!path || typeof path !== 'string') return false
  const trimmed = path.trim()
  if (trimmed.length === 0) return false

  if (baselinePaths && (baselinePaths.has(trimmed) || baselinePaths.has(resolve(trimmed)))) {
    return true
  }

  if (trimmed === '~/.dsh/AGENTS.md' || trimmed === '$DSH_HOME/AGENTS.md'
    || trimmed.replace(/\\/g, '/').endsWith('.dsh/AGENTS.md')) {
    return true
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (baselinePaths) {
    for (const bp of baselinePaths) {
      if (typeof bp === 'string' && bp.replace(/\\/g, '/') === normalized) {
        return true
      }
    }
  }

  if (typeof cwd === 'string' && cwd.length > 0) {
    const normCwd = resolve(cwd).replace(/\\/g, '/')
    const normPath = resolve(cwd, trimmed).replace(/\\/g, '/')
    const dir = dirname(normPath)
    if (normCwd === dir || normCwd.startsWith(dir + '/')) {
      return true
    }
  }

  if (normalized === 'AGENTS.md' || normalized === 'CLAUDE.md'
    || normalized === 'AGENTS.local.md' || normalized === 'CLAUDE.local.md'
    || normalized === '/repo/AGENTS.md' || normalized === '/repo/CLAUDE.md') {
    return true
  }

  return false
}

/**
 * Check whether an agent-instructions message is purely baseline instructions,
 * by examining both structured changes in source and text headers in content.
 */
export function isMessagePureBaseline(message, cwd, baselinePaths) {
  // If structured changes exist, check for any non-baseline actions or scopes
  if (Array.isArray(message?.source?.changes) && message.source.changes.length > 0) {
    for (const change of message.source.changes) {
      if (change?.action === 'replace' || change?.action === 'remove') return false
      if (typeof change?.path === 'string' && !isBaselineInstructionPath(change.path, baselinePaths, cwd)) {
        return false
      }
    }
  }

  // Check content blocks for explicit dynamic headers
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const lower = block.text.toLowerCase()
    if (lower.includes('additional instructions from:')
      || lower.includes('updated instructions from:')
      || lower.includes('instructions removed:')) {
      return false
    }
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const p = match[1]?.trim()
      if (p && !isBaselineInstructionPath(p, baselinePaths, cwd)) {
        return false
      }
    }
  }

  return true
}

/**
 * Discover instruction files in a specific subdirectory under projectRoot.
 */
export async function discoverSubdirectoryInstructions(cwd, targetDir, deliveredScopes = new Set()) {
  const root = await findProjectRoot(cwd)
  const normTarget = resolve(targetDir)
  const normRoot = resolve(root)
  const normCwd = resolve(cwd)

  if (!normTarget.startsWith(normRoot)) return []
  if (normTarget === normCwd || normCwd.startsWith(normTarget + '/')) return []

  const dirs = []
  for (let curr = normTarget; curr.length >= normRoot.length && curr.startsWith(normRoot); curr = dirname(curr)) {
    if (curr === normCwd || normCwd.startsWith(curr + '/')) break
    dirs.push(curr)
  }
  dirs.reverse()

  const results = []
  for (const dir of dirs) {
    const scope = relative(normRoot, dir).replace(/\\/g, '/')
    if (deliveredScopes.has(scope)) continue

    for (const candidate of INSTRUCTION_FILE_CANDIDATES) {
      const filePath = join(dir, candidate)
      const st = await statFile(filePath)
      if (st?.isFile()) {
        const content = await readInstructionFile(filePath, st.size)
        if (content !== undefined) {
          results.push({
            displayPath: relative(normRoot, filePath).replace(/\\/g, '/'),
            scope,
            content,
          })
          break
        }
      }
    }
  }
  return results
}

export function formatAdditionalSection(displayPath, scope, content) {
  return [
    `Additional instructions from: ${displayPath}`,
    '',
    `These instructions apply to work under \`${scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`,
    '',
    content,
  ].join('\n')
}

/**
 * Filter and reconcile instructions messages:
 * - Condenses pure covered baseline messages into a concise legal user message
 *   preserving source.baseline and schema in normal decision.messages.
 * - Leaves dynamic/updated instructions intact.
 * - Passes through untouched if baseline loading failed.
 */
export function filterInstructionMessages(messages, baselineFiles = [], baselineLoaded = false, agent = undefined) {
  const kept = []
  const cwd = agent?.session?.header?.cwd
  const baselinePaths = new Set(baselineFiles.map(f => f.displayPath).concat(baselineFiles.map(f => f.absolutePath)))

  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }

    const pureBaseline = isMessagePureBaseline(message, cwd, baselinePaths)

    if (!pureBaseline) {
      // Dynamic subdirectory instructions or mixed changes: keep safely.
      kept.push(message)
      continue
    }

    // The message duplicates content the system prompt carries, so it is
    // redundant ONLY when that prompt really carries it. A failed or empty
    // baseline read must never cost the model its instructions, whatever shape
    // the message has: pass it through untouched.
    if (!baselineLoaded) {
      kept.push(message)
      continue
    }

    // A marked baseline keeps a short marker message, which is what the host's
    // baseline detector reads to stop re-injecting the same baseline every step.
    // An unmarked one has nothing to contribute on top of the prompt.
    if (message?.source?.baseline !== true) continue

    const covered = baselineFiles.map(f => f.displayPath).filter(Boolean)
    const text = covered.length > 0
      ? `<system-reminder>\nWorkspace baseline instructions (${covered.join(', ')}) are active in the system prompt.\n</system-reminder>`
      : '<system-reminder>\nWorkspace baseline instructions are active in the system prompt.\n</system-reminder>'
    kept.push({
      ...message,
      content: [{ type: 'text', text }],
    })
  }
  return kept
}

/** Backward-compatible export: alias for filterInstructionMessages. */
export function dropInstructionMessages(messages, baselineFiles = [], baselineLoaded = false, agent = undefined) {
  return filterInstructionMessages(messages, baselineFiles, baselineLoaded, agent)
}

/**
 * Workspace line the persona gains. The one-line persona carries no
 * orientation facts, so the session's selected workspace directory is appended
 * to the persona section at assembly time. The literal cwd comes from the
 * session header, so the line stays correct after a workspace switch, and a
 * session without a readable cwd keeps the bare persona rather than failing.
 */
const WORKSPACE_LINE_PREFIX = '\n\nYour working directory is '

/** Append the workspace line to the persona section, once. */
export function withWorkspaceLine(sections, agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return sections
  const line = `${WORKSPACE_LINE_PREFIX}${cwd}.`
  const persona = sections.find(section =>
    PERSONA_SECTION_NAMES.includes(section?.name)
    && typeof section?.text === 'string'
    && !section.text.includes(line))
  if (persona === undefined) return sections
  return sections.map(section => section === persona
    ? { ...section, text: `${section.text}${line}` }
    : section)
}

/** Register the section filter, workspace-instruction source, and dynamic discovery hooks. */
export function apply(ctx, config) {
  const instructionMaxBytes = optionalByteSize(config?.instructionMaxBytes, 'instructionMaxBytes', DEFAULT_INSTRUCTION_MAX_BYTES)

  // Per-session state tracking (durable across steps, recoverable on replay)
  const sessionStateMap = new WeakMap()
  const getSessionState = (session) => {
    let state = sessionStateMap.get(session)
    if (!state) {
      state = {
        touchedDirs: new Set(),
        deliveredScopes: new Set(),
        baselineLoaded: false,
        baselineFiles: [],
        hinted: false,
      }
      sessionStateMap.set(session, state)

      // Reconstruct touched directories from durable history if available
      if (typeof session?.snapshotEvents === 'function') {
        try {
          const events = session.snapshotEvents()
          const cwd = session.header?.cwd ?? process.cwd()
          for (const ev of events) {
            if (ev?.type === 'tool/call' && ev.data) {
              let args = ev.data.arguments
              if (typeof args === 'string') {
                try { args = JSON.parse(args) } catch {}
              }
              const p = filePathFromExecution({ name: ev.data.name, arguments: args })
              if (p) state.touchedDirs.add(dirname(resolve(cwd, p)))
            }
          }
        } catch {
          // Replay reconstruction fallback
        }
      }
    }
    return state
  }

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Logger unavailable
    }
  }

  // 1. System Prompt Assembly
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (!Array.isArray(assembled.sections)) return assembled
    // B1 derivation: the official assembly is kept whole; only the
    // `workspace-instructions` section below is appended to it.
    const sections = assembled.sections

    let text
    const session = context?.agent?.session
    const state = session ? getSessionState(session) : undefined
    const cwd = session?.header?.cwd
    try {
      if (cwd) {
        const files = await loadInstructionFiles(cwd)
        if (state) {
          state.baselineLoaded = true
          state.baselineFiles = files
        }
        text = renderInstructionSection(files, instructionMaxBytes)
      }
    } catch (error) {
      if (state) state.baselineLoaded = false
      warnOnce(`${name}: reading the workspace instructions failed — sending the prompt without them (${error instanceof Error ? error.message : String(error)})`)
      return { ...assembled, sections: sections }
    }
    if (text === undefined) return { ...assembled, sections: sections }

    return {
      ...assembled,
      sections: [...sections, { name: WORKSPACE_INSTRUCTIONS_SECTION_NAME, text: `{{${WORKSPACE_INSTRUCTIONS_VARIABLE}}}` }],
      variables: { ...assembled.variables, [WORKSPACE_INSTRUCTIONS_VARIABLE]: text },
    }
  }, { prepend: true })

  // 2. Synchronous tool result tracking (no fake emit, no async work in emit listener)
  ctx.on('tools/result', (exec, result) => {
    if (result?.isError || !exec?.agent || exec?.signal?.aborted) return
    const path = filePathFromExecution(exec)
    if (!path) return

    const session = exec.agent.session
    if (!session) return

    const cwd = session.header?.cwd ?? process.cwd()
    const state = getSessionState(session)
    state.touchedDirs.add(dirname(resolve(cwd, path)))
  })

  // 3. Agent pre-step message filter & dynamic discovery
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    const agent = payload?.agent
    const session = agent?.session
    const state = session ? getSessionState(session) : undefined


    // System-prompt mode:
    const cwd = session?.header?.cwd
    const baselineLoaded = state?.baselineLoaded ?? false
    const baselineFiles = state?.baselineFiles ?? []

    // Step A: Filter incoming decision messages
    const filtered = filterInstructionMessages(decision.messages, baselineFiles, baselineLoaded, agent)

    // Step B: Asynchronously discover dynamic instructions for touched directories
    if (state && cwd) {
      const newSections = []
      for (const dir of state.touchedDirs) {
        const discovered = await discoverSubdirectoryInstructions(cwd, dir, state.deliveredScopes)
        for (const file of discovered) {
          state.deliveredScopes.add(file.scope)
          newSections.push(formatAdditionalSection(file.displayPath, file.scope, file.content))
        }
      }
      if (newSections.length > 0) {
        filtered.push({
          id: globalThis.crypto.randomUUID(),
          role: 'user',
          content: [{
            type: 'text',
            text: `<system-reminder>\n${newSections.join('\n\n')}\n</system-reminder>`,
          }],
          source: { kind: 'plugin', plugin: name },
        })
      }
    }

    return { ...decision, messages: filtered }
  }, { prepend: true })

  // 4. Session lifecycle / compaction recovery
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'compaction/end') {
      const state = sessionStateMap.get(session)
      if (state) {
        state.hinted = false
        state.deliveredScopes.clear()
      }
    }
  })
}
