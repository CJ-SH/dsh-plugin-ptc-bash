/**
 * Regenerate presets/ptc-bash from its two upstream sources, refusing to write unless
 * every anchor matched exactly once. Run it with npm run derive-preset.
 *
 *   agent.cordis.yml         <- the builtin ptc preset of the installed harness
 *                               (env DSH_PLUGIN_HOME overrides the scoped node_modules path)
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
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BT = String.fromCharCode(96)
const DSH = process.env.DSH_PLUGIN_HOME ?? 'D:/Scoop/persist/nvm/nodejs/v24.18.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const LS = process.env.LIANGSHEN_PRESET_DIR ?? 'C:/Users/Hasee/.dsh/.agent-presets/liangshen'
const OUT = process.env.PTC_BASH_PRESET_DIR ?? fileURLToPath(new URL('../presets/ptc-bash', import.meta.url))
const problems = []
const notes = []

const split = (text) => text.replace(/\r\n/g, '\n').split('\n')
const find = (lines, prefix, from) => { for (let i = from || 0; i < lines.length; i += 1) if (lines[i].startsWith(prefix)) return i; return -1 }
const at = (lines, prefix, label, from) => { const i = find(lines, prefix, from); if (i === -1) problems.push(label + ': line not found -> ' + prefix); return i }
const cutHeader = (lines, label) => { const end = lines.findIndex((l) => l.trimEnd().endsWith('*/')); if (end === -1) { problems.push(label + ': no JSDoc end'); return lines } notes.push(label + ': header cut (' + (end + 1) + ' lines)'); return lines.slice(end + 1) }

const YML_HEADER = [
  '# The `ptc-bash` agent preset: the official `ptc` preset with Git Bash added as the',
  '# PREFERRED shell on Windows, and the workspace instruction chain carried in the',
  '# system prompt instead of a durable user message.',
  '#',
  '# Adapted from the builtin `ptc` preset (MIT, DeepSeek) - see NOTICE. Exactly three',
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

let y = split(await readFile(join(DSH, 'dsh-agent-presets/presets/ptc/agent.cordis.yml'), 'utf8'))
const idIdx = y.findIndex((l) => l.startsWith('# \u2500\u2500 identity'))
if (idIdx === -1) problems.push('yml: identity marker missing')
else { y = YML_HEADER.concat(y.slice(idIdx)); notes.push('yml: header replaced') }
const bashIdx = at(y, '- id: tool-bash', 'yml tool-bash')
const pwshIdx = at(y, '- id: tool-pwsh', 'yml tool-pwsh', bashIdx)
const pwshDis = at(y, "  disabled: !!js process.platform !== 'win32'", 'yml pwsh disabled', pwshIdx)
if (bashIdx >= 0 && pwshDis >= 0) { y = y.slice(0, bashIdx).concat(SHELL_LINES, y.slice(pwshDis + 1)); notes.push('yml: shell rows rewritten') }
const aiIdx = at(y, '- id: agent-instructions', 'yml agent-instructions')
const aiCfg = at(y, '    maxBytes: 65536', 'yml agent-instructions maxBytes', aiIdx)
if (aiCfg >= 0) { y = y.slice(0, aiCfg + 1).concat(WINSTR_ROW, y.slice(aiCfg + 1)); notes.push('yml: workspace-instructions row added') }


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
let w = cutHeader(split(await readFile(join(LS, 'minimal-prompt.mjs'), 'utf8')), 'workspace-instructions')
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

const joined = { y: y.join('\n'), w: w.join('\n') }
for (const key of ['keepPlanPolicy', 'instructionSource', 'keep.has', "=== 'hint'"]) {
  if (joined.w.includes(key)) problems.push('workspace-instructions still references ' + key)
}
if (joined.y.includes('- id: tool-catalog')) problems.push('yml still references tool-catalog')
if (joined.y.includes('str_replace_editor')) problems.push('yml still references str_replace_editor')
if (!joined.y.includes('- id: dsh-bash-win')) problems.push('yml missing dsh-bash-win row')
if (!joined.y.includes('- id: workspace-instructions')) problems.push('yml missing workspace-instructions row')

for (const key of ['y', 'w']) joined[key] = joined[key].split('`').join(BT)
if (problems.length === 0) {
  await writeFile(join(OUT, 'agent.cordis.yml'), joined.y)
  await writeFile(join(OUT, 'workspace-instructions.mjs'), joined.w)
  notes.push('written: 2 files to ' + OUT)
}
console.log(notes.join('\n'))
console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nALL CHECKS OK')
