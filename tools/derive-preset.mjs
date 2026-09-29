/**
 * Regenerate presets/ptc-bash from its two upstream sources, refusing to write unless
 * every anchor matched exactly once. Run it with npm run derive-preset.
 *
 *   agent.cordis.yml           <- the `plugins` list of the installed harness' `ptc`
 *                                 agent preset, which 0.2.0 ships as a loader patch
 *                                 (`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`,
 *                                 `insert[0].config.plugins`) instead of a preset
 *                                 directory. Env DSH_INSTALL_ROOT names the `dsh` package
 *                                 root and DSH_PLUGIN_HOME its `@deepseek-ai` directory;
 *                                 without either, the install is followed from
 *                                 $DSH_HOME/profiles.
 *   workspace-instructions.mjs <- a liangshen preset directory
 *                               (env LIANGSHEN_PRESET_DIR overrides its location)
 *
 * presets/ptc-bash/dsh-bash-win.mjs is NOT derived here: it began as a port of the
 * same upstream custom-bash.mjs, has since been extended in this repo (background
 * jobs, timeoutMs, description) and renamed. See NOTICE; edits there are intentional.
 *
 * Output goes to presets/ptc-bash (env PTC_BASH_PRESET_DIR overrides that). See NOTICE
 * for what each derivation changes; the assertions below are the same contract the tests
 * check, so a drifted upstream fails the run instead of silently producing a bad preset.
 *
 * Note for a future re-derivation: 0.2.0's patch was written by the harness' own YAML
 * dump, so it carries no comments. Re-deriving therefore replaces the file's explanatory
 * comments with the rows alone — the rows themselves are identical (verified row by row
 * against the checked-in file when this anchor was moved). Point PTC_BASH_PRESET_DIR at
 * a scratch directory and read the diff before overwriting a commented file.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BT = String.fromCharCode(96)
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LS = process.env.LIANGSHEN_PRESET_DIR ?? join(HOME, '.agent-presets', 'liangshen')
const OUT = process.env.PTC_BASH_PRESET_DIR ?? fileURLToPath(new URL('../presets/ptc-bash', import.meta.url))
const problems = []
const notes = []

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const split = (text) => text.replace(/\r\n/g, '\n').split('\n')
const indentOf = (line) => line.length - line.trimStart().length
const find = (lines, prefix, from) => { for (let i = from || 0; i < lines.length; i += 1) if (lines[i].startsWith(prefix)) return i; return -1 }
const at = (lines, prefix, label, from) => { const i = find(lines, prefix, from); if (i === -1) problems.push(label + ': line not found -> ' + prefix); return i }
const cutHeader = (lines, label) => { const end = lines.findIndex((l) => l.trimEnd().endsWith('*/')); if (end === -1) { problems.push(label + ': no JSDoc end'); return lines } notes.push(label + ': header cut (' + (end + 1) + ' lines)'); return lines.slice(end + 1) }

/** Whether `directory` is the install root: the shipped web app sits under it. */
async function isInstallRoot(directory) {
  try {
    await readFile(join(directory, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'))
    return true
  } catch {
    return false
  }
}

/**
 * The install's `dsh` package root, where the shipped `ptc` preset lives.
 *
 * Nothing about this machine is baked in — no node version, no user name. An explicit
 * override is accepted as the `dsh` package root itself, as the `@deepseek-ai` directory
 * holding it (what DSH_PLUGIN_HOME named before 0.2.0), or as the scoped directory
 * inside it; otherwise the profile's junction to the install decides.
 */
async function installRoot() {
  for (const value of [process.env.DSH_INSTALL_ROOT, process.env.DSH_PLUGIN_HOME]) {
    if (value === undefined) continue
    for (const candidate of [value, join(value, 'dsh'), dirname(dirname(value))]) {
      if (await isInstallRoot(candidate)) return candidate
    }
    problems.push('install: ' + value + ' is not a dsh install (no node_modules/@deepseek-ai/dsh-web-app under it)')
  }
  const profiles = join(HOME, 'profiles')
  const scopes = [join(profiles, 'node_modules')]
  for (const entry of await readdir(profiles, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() || entry.isSymbolicLink()) scopes.push(join(profiles, entry.name, 'node_modules'))
  }
  for (const scope of scopes) {
    const candidate = join(scope, '@deepseek-ai', 'dsh')
    if (await isInstallRoot(candidate)) return candidate
  }
  problems.push('install: no dsh install found under ' + profiles + ' — set DSH_INSTALL_ROOT to the dsh package root')
  return undefined
}

/** One upstream source, or a problem that stops the run before it writes anything. */
async function source(path, label) {
  try {
    return split(await readFile(path, 'utf8'))
  } catch (error) {
    problems.push(label + ': unreadable -> ' + path + ' (' + messageOf(error) + ')')
    return undefined
  }
}

/**
 * The upstream `ptc` rows, dedented out of the shipped loader patch.
 *
 * The preset is the `plugins:` list of the patch's single declaration. Anchoring on that
 * key rather than on a line number is what keeps this working when the shipped preset
 * gains or loses a row above it; both ends of the list are then asserted by id, so a
 * truncated read fails the run instead of writing a shorter preset.
 */
function upstreamRows(patch, path) {
  const headers = []
  for (const [index, line] of patch.entries()) if (/^\s*plugins:\s*$/.test(line)) headers.push({ index, indent: indentOf(line) })
  if (headers.length !== 1) {
    problems.push('patch: expected exactly one "plugins:" line, found ' + headers.length)
    return undefined
  }
  const { index, indent } = headers[0]
  const block = []
  for (let i = index + 1; i < patch.length; i += 1) {
    const line = patch[i]
    if (line.trim() === '') { block.push(''); continue }
    if (indentOf(line) <= indent) break
    block.push(line)
  }
  while (block.length > 0 && block[block.length - 1] === '') block.pop()
  const first = block.find((line) => line.trim() !== '')
  if (first === undefined) {
    problems.push('patch: the "plugins:" block is empty')
    return undefined
  }
  const base = indentOf(first)
  const rows = block.map((line) => (line.trim() === '' ? '' : line.slice(base)))
  for (const id of ['persona', 'tool-plugin-manager']) {
    if (!rows.includes('- id: ' + id)) problems.push('patch: the plugins block does not carry its row "' + id + '"')
  }
  notes.push('yml: ' + rows.filter((line) => line.startsWith('- id: ')).length + ' upstream rows read from ' + path)
  return rows
}

const YML_HEADER = [
  '# The `ptc-bash` agent preset: the official `ptc` preset with Git Bash added as the',
  '# PREFERRED shell on Windows, and the workspace instruction chain carried in the',
  '# system prompt instead of a durable user message.',
  '#',
  '# Adapted from the shipped `ptc` preset (MIT, DeepSeek) - see NOTICE. Exactly three',
  '# changes vs. the original; every other line is byte-for-byte identical:',
  '#',
  '#   1. the shell section adds `dsh-bash-win` (win32 Git Bash) beside the official',
  '#      `tool-bash` / `tool-pwsh` pair, which keeps its platform gates;',
  '#   2. the identity section adds `workspace-instructions` (AGENTS.md chain into the',
  '#      system prompt; that plugin also collapses the official row injections into marker',
  '#      messages so the instructions never arrive twice);',
  '#   3. this header.',
  '#',
  '# The "anchor turn" of the mode this was derived from is deliberately absent:',
  '# `tool-presentation` declares PTC for the whole session, so the first turn already runs',
  '# on `run_code` + the generated SDK, and no durable tool catalog is injected.',
  '#',
  '# Windows keeps `pwsh` mounted as the fallback shell - it is the only file-sandboxed',
  '# shell there. The preference for bash is expressed on the bash side (its tool',
  '# description and the `tool:bash` prompt section), never by weakening this row.',
  '#',
  '# This file is an AGENT-PLANE composition mounted under one agent scope; a service',
  '# row here MUST sit inside a group carrying an `isolate` realm.',
  '',
]
const SHELL_LINES = [
  '# One shell tool per platform, plus the harness own pwsh on Windows. The official',
  '# pairing (bash on POSIX, pwsh on win32) keeps its gates; `dsh-bash-win` adds the Git Bash',
  '# tool win32 otherwise lacks, and is the PREFERRED shell - see its tool',
  '# description and the `tool:bash` prompt section it registers.',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '',
  '# Kept as the fallback shell: the only file-sandboxed shell on Windows, and the',
  '# native one for Windows-specific work.',
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
  '',
  '- id: dsh-bash-win',
  '  name: ./dsh-bash-win.mjs',
  "  disabled: !!js process.platform !== 'win32'",
]
const WINSTR_ROW = [
  '',
  '',
  '# B1 addition: the workspace instruction chain (AGENTS.md / CLAUDE.md) is rendered',
  '# into the system prompt on every assembly, so it survives compaction and picks up',
  '# file edits without a durable message. The plugin also rewrites the injections the',
  '# official row above makes into short marker messages.',
  '- id: workspace-instructions',
  '  name: ./workspace-instructions.mjs',
  '  config:',
  '    instructionMaxBytes: 65536',
]

const root = await installRoot()
const patchPath = root === undefined ? undefined : join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml')
const patch = patchPath === undefined ? undefined : await source(patchPath, 'ptc patch')
const liangshen = await source(join(LS, 'minimal-prompt.mjs'), 'workspace-instructions')

let y
if (patch !== undefined) y = YML_HEADER.concat(upstreamRows(patch, patchPath) ?? [])
if (y !== undefined) {
  const bashIdx = at(y, '- id: tool-bash', 'yml tool-bash')
  const pwshIdx = at(y, '- id: tool-pwsh', 'yml tool-pwsh', bashIdx)
  const pwshDis = at(y, "  disabled: !!js process.platform !== 'win32'", 'yml pwsh disabled', pwshIdx)
  if (bashIdx >= 0 && pwshDis >= 0) { y = y.slice(0, bashIdx).concat(SHELL_LINES, y.slice(pwshDis + 1)); notes.push('yml: shell rows rewritten') }
  const aiIdx = at(y, '- id: agent-instructions', 'yml agent-instructions')
  const aiCfg = at(y, '    maxBytes: 65536', 'yml agent-instructions maxBytes', aiIdx)
  if (aiCfg >= 0) { y = y.slice(0, aiCfg + 1).concat(WINSTR_ROW, y.slice(aiCfg + 1)); notes.push('yml: workspace-instructions row added') }
}

const WI_HEADER = [
  '/**',
  ' * workspace-instructions - carry the workspace instruction chain in the system prompt,',
  ' * with every official prompt section left untouched.',
  ' *',
  ' * Provenance: derived from @linxin666/dsh-liangshen minimal-prompt.mjs (Apache-2.0),',
  ' * which carries the dsh-anchored-standard experiment (MIT). See NOTICE and LICENSES/.',
  ' * Removed here: the prompt section narrowing (the official `ptc` assembly keeps all of',
  ' * its sections), the `hint` instruction mode, and the workspace-directory line (the',
  ' * official persona already renders the cwd).',
  ' *',
  ' * Kept unchanged, because these are the parts that are easy to get subtly wrong:',
  ' *',
  ' *  - the baseline chain (DSH_HOME/AGENTS.md, then project root -> cwd, candidates',
  ' *    AGENTS.md/CLAUDE.md plus `.local` overlays, per-directory duplicate',
  ' *    suppression, byte budget), re-read on every assembly;',
  ' *  - the appended `workspace-instructions` section whose text is only a',
  ' *    {{workspace_instructions}} reference: the renderer interpolates section text',
  ' *    strictly, while an assembly variable value is inserted verbatim;',
  ' *  - the rewrite of the official `dsh-agent-instructions` injections into short marker',
  ' *    messages - the message itself is kept (the host baseline detector reads it to',
  ' *    stop re-injecting every step) while the body is dropped, which is what keeps the',
  ' *    instructions from arriving twice;',
  ' *  - dynamic discovery for directories touched outside that chain, delivered as user',
  ' *    messages (never as system prompt), re-armed after compaction.',
  ' *',
  ' * Failure mode: any read/render error warns once and falls back to the untouched',
  ' * assembly plus untouched messages - the request always proceeds.',
  ' */',
  '',
]
let w = liangshen === undefined ? [] : cutHeader(liangshen, 'workspace-instructions')
const nameIdx = at(w, 'export const name =', 'workspace-instructions name')
if (nameIdx >= 0) { w[nameIdx] = "export const name = 'workspace-instructions'"; notes.push('workspace-instructions: renamed') }
const srcIdx = at(w, 'export const INSTRUCTION_SOURCES =', 'instruction sources')
if (srcIdx >= 0) { const count = srcIdx > 0 && w[srcIdx - 1].startsWith('/** Accepted') ? 2 : 1; w.splice(srcIdx - (count - 1), count); notes.push('workspace-instructions: hint constant removed') }
const kpIdx = at(w, '  const keepPlanPolicy =', 'keepPlanPolicy')
const ksIdx = at(w, '  const keep = new Set([', 'keep set')
let keIdx = -1
for (let i = ksIdx; i < w.length; i += 1) if (w[i] === '  ])') { keIdx = i; break }
if (keIdx === -1) problems.push('keep set end not found')
if (keIdx >= 0) { w.splice(ksIdx, keIdx - ksIdx + 1); notes.push('workspace-instructions: keep set removed') }
if (kpIdx >= 0) { w.splice(kpIdx, 2); notes.push('workspace-instructions: config reads removed') }
const fIdx = at(w, '    const sections = assembled.sections.filter(', 'section filter')
let feIdx = -1
for (let i = fIdx; i < w.length; i += 1) if (w[i] === '    }') { feIdx = i; break }
if (feIdx === -1) problems.push('filter guard end not found')
if (feIdx >= 0) { w.splice(fIdx, feIdx - fIdx + 1, '    // B1 derivation: the official assembly is kept whole; only the', '    // `workspace-instructions` section below is appended to it.', '    const sections = assembled.sections'); notes.push('workspace-instructions: filter removed') }
const erIdx = at(w, "    if (instructionSource !== 'system-prompt')", 'hint early return')
if (erIdx >= 0) { w.splice(erIdx, 1); notes.push('workspace-instructions: hint early return removed') }
const hbIdx = at(w, "    if (instructionSource === 'hint') {", 'hint branch')
if (hbIdx >= 0) { w.splice(hbIdx, 4); notes.push('workspace-instructions: hint branch removed') }
w = WI_HEADER.concat(w)

const keptLines = w.filter((line) => !line.includes('withWorkspaceLine(sections, context?.agent)'))
if (keptLines.length === w.length) problems.push('workspace-instructions: workspace-line call not found')
w = keptLines.join('\n').split('narrowed').join('sections').split('\n')

const joined = { y: y === undefined ? '' : y.join('\n'), w: w.join('\n') }
for (const key of ['keepPlanPolicy', 'instructionSource', 'keep.has', "=== 'hint'"]) {
  if (joined.w.includes(key)) problems.push('workspace-instructions still references ' + key)
}
if (joined.y.includes('- id: tool-catalog')) problems.push('yml still references tool-catalog')
if (joined.y.includes('str_replace_editor')) problems.push('yml still references str_replace_editor')
if (!joined.y.includes('- id: dsh-bash-win')) problems.push('yml missing dsh-bash-win row')
if (!joined.y.includes('- id: workspace-instructions')) problems.push('yml missing workspace-instructions row')

for (const key of ['y', 'w']) joined[key] = joined[key].split('`').join(BT)

/**
 * Replace one generated file in a single step.
 *
 * A derived file is read at activation, so a half-written one is a broken preset until
 * the next run; the temporary file is removed again when the rename fails.
 */
async function writeAtomic(target, text) {
  const temporary = target + '.tmp-' + process.pid
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temporary, text)
  try {
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

console.log(notes.join('\n'))
if (problems.length > 0) {
  // Nothing was written, and the run says so with a non-zero status: a missing anchor
  // means the upstream moved, and a "successful" run that produced no file is worse than
  // a failed one.
  console.error('\nPROBLEMS:\n' + problems.join('\n') + '\n\nnothing written')
  process.exitCode = 1
} else {
  await writeAtomic(join(OUT, 'agent.cordis.yml'), joined.y)
  await writeAtomic(join(OUT, 'workspace-instructions.mjs'), joined.w)
  console.log('written: 2 files to ' + OUT)
  console.log('\nALL CHECKS OK')
}
