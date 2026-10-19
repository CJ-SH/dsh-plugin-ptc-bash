/**
 * dsh-bash-win - the Windows `bash` tool of the `ptc-bash` preset.
 *
 * It registers under the name `bash` and drives ONE long-lived `bash -s` process per
 * session through `ctx.subprocess` instead of a PTY, because the PTY backend is
 * linux/darwin-only: subprocess-local refuses terminal inspection on platform win32. The
 * official `tool-bash` row stays disabled on win32 and the official `tool-pwsh` row stays
 * mounted as the fallback shell; a POSIX session never mounts this row.
 *
 * Lineage: the resolver and the basic execution shape were ported from
 * xiaobright/dsh-anchored-standard combo-anchored/custom-bash.mjs (MIT); the copy this was
 * derived from ships inside @linxin666/dsh-liangshen (Apache-2.0). The heredoc-sourcing
 * frame below is independently re-derived from @linxin666/dsh-win-bash (Apache-2.0); see
 * NOTICE. This file has since been extended here:
 *
 *  1. the tool description states the shell preference (bash first, `pwsh` only when the
 *     task specifically requires PowerShell) and drops the wrong claims of a Linux
 *     container (network, apt/pip mirrors, landlock);
 *  2. it registers the `tool:bash` prompt section in the slot the official bash tool uses
 *     on POSIX (order 1000), carrying the same rule into the prompt;
 *  3. the shell is PERSISTENT: one process per session, so `cd`, exported variables,
 *     functions and aliases survive across calls. `workdir` is written as `cd -- <dir>`
 *     inside that shell and therefore changes the directory later calls start in;
 *  4. the session's own sandbox policy is resolved first: the MSYS2 bash cannot start
 *     under a restricted token, so a session outside `danger-full-access` is refused
 *     before any process is spawned, and the error points at `pwsh`;
 *  5. it supports the official parameter set - `description`, `timeoutMs` and
 *     `run_in_background` - plus the configured caps behind them;
 *  6. background runs register with the host `ctx.jobs` registry and run in their OWN
 *     process, so a job outlives the session shell it was started beside;
 *  7. results follow the official bash rendering: stdout, a marked stderr section, then
 *     `[timed out after Nms]` / `[killed by signal: S]` / `[exit code: N]` markers. A
 *     non-zero exit is REPORTED, not errored - only invalid arguments, spawn failures and
 *     an aborted tool call surface as error results. The same result carries structured
 *     fields (`stdout`, `stderr`, `exitCode`, truncation facts, spill paths).
 *
 * Unchanged: Git Bash inference (git install root -> env-derived roots -> PATH), explicit
 * `bashPath`, bounded output with the spill path reported when the visible text loses its
 * head, and NO silent fallback to pwsh/cmd. The PATH fallback may pick the WSL shim, still
 * bash but with /mnt/... paths - the Git Bash roots are probed first for that reason.
 *
 * Shell environment: the subprocess service scrubs every ambient `DSH_*` name, so the
 * per-execution dsh facts (`DSH_SESSION_ID`, `DSH_SHELL`, `DSH_HOME`, contributor
 * variables) are read from `ctx.shellEnv.collect(exec)` and passed as the spawn spec's
 * explicit `env`. The overlay is captured when the shell starts (a shell is keyed by its
 * owning agent, so the session identity is stable for its lifetime). Without it, work run
 * inside this shell cannot tell which dsh session it belongs to, and Trellis' `task.py`
 * falls back to its degraded mode (status/branch recorded, per-session pointer never
 * written).
 *
 * Known limits: `exit` in a command ends the shell (the call reports it and the next call
 * starts a fresh one); a command that waits on stdin keeps the shell busy until
 * `timeoutMs`; stderr written after the frame's end marker can land in the next call's
 * stderr section.
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-bash-win'

/** The subprocess, tools, system-prompt and shell-env services must exist before this plugin applies. */
export const inject = ['subprocess', 'tools', 'systemPrompt', 'shellEnv']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TIMEOUT_MS = 600000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const GRACE_MS = 3000
/** In-memory tail the persistent shell's collectors retain. */
const SHELL_TAIL_BYTES = 1 << 20
const SHELL_STDERR_BYTES = 256 << 10
const SHELL_SPILL_BYTES = 32 << 20
const POLL_INTERVAL_MS = 10
const START_TIMEOUT_MS = 15000
const MARKER_PREFIX = '__dsh_ptc_bash_'
const PREFERRED_SANDBOX_MODE = 'danger-full-access'

/**
 * Git Bash candidate paths, in probe order: the `git` executable install root first,
 * then the well-known env-derived roots. Pure; existence probing happens at the
 * call site.
 */
export function bashCandidates(env, gitExe) {
  const candidates = []
  // git at <root>\cmd\git.exe (installer/scoop) or <root>\bin\git.exe ->
  // <root>\bin\bash.exe; <root>\mingw64\bin\git.exe (portable) -> two up.
  // A bare relative name means `git` did not actually resolve to a path.
  if (typeof gitExe === 'string' && /[/\\]/.test(gitExe)) {
    const dir = dirname(gitExe)
    const root = dirname(dir)
    candidates.push(
      join(root, 'bin', 'bash.exe'),
      join(dir, 'bash.exe'),
      join(dirname(root), 'bin', 'bash.exe'),
    )
  }
  if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'))
  if (env['ProgramFiles(x86)']) candidates.push(join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'))
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  if (env.USERPROFILE) candidates.push(join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  // Layouts overlap (a `bin` git.exe derives the same bash twice) - probe order
  // survives the dedupe, insertion order is preserved.
  return [...new Set(candidates)]
}

/** Positive-integer config knob with a fallback; invalid values fall back. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Validate the model-facing arguments the way the official shell tools do. */
function validateArgs(args) {
  if (typeof args?.command !== 'string' || args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (typeof args?.description !== 'string' || args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args?.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error('invalid timeoutMs: expected a positive number, got ' + JSON.stringify(args.timeoutMs))
  if (args?.workdir !== undefined && (typeof args.workdir !== 'string' || args.workdir.length === 0)) throw new Error('invalid workdir: expected a non-empty string')
  if (args?.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new Error('invalid run_in_background: expected a boolean')
}

/**
 * The `DSH_*` facts for THIS execution, or undefined when the registry cannot supply them.
 *
 * `collect` is resolved per execution, so the session id it carries is the session running
 * this call (the session itself, or the sub-agent session when a sub-agent drives the
 * shell). The subprocess service strips ambient `DSH_*` names, which makes this overlay the
 * only channel those facts can reach the child through. A registry that is missing, throws,
 * or yields nothing degrades to "no overlay": the shell has to keep working when the
 * environment facts are unavailable.
 */
function collectShellEnv(ctx, exec) {
  try {
    const registry = ctx.shellEnv
    if (registry === undefined || typeof registry.collect !== 'function') return undefined
    const overlay = registry.collect(exec)
    if (overlay === null || typeof overlay !== 'object') return undefined
    return Object.keys(overlay).length === 0 ? undefined : overlay
  } catch {
    return undefined
  }
}

/** Append one line block to a body, keeping a single newline between them. */
function appendLine(body, line) {
  if (body.length === 0) return line
  return (body.endsWith('\n') ? body : body + '\n') + line
}

/** A fresh, collision-resistant frame marker pair for one command. */
export function markerFor() {
  const token = globalThis.crypto.randomUUID().replace(/-/g, '')
  return {
    begin: MARKER_PREFIX + token + '_begin',
    end: MARKER_PREFIX + token + '_end',
  }
}

/** Quote one value for a POSIX shell (single quotes, embedded quotes escaped). */
export function shellQuote(value) {
  return "'" + String(value).split("'").join("'\\''") + "'"
}

/**
 * Turn the model's `workdir` into the directory the shell changes into.
 *
 * A leading `~` expands against the host home (bash would not expand it inside the single
 * quotes the frame uses); a relative path resolves against the session directory; Windows
 * separators become forward slashes so the MSYS2 bash resolves the same place.
 */
export function normalizeWorkdir(value, sessionCwd) {
  let path = String(value)
  if (path === '~') path = homedir()
  else if (path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(2))
  else if (!isAbsolute(path) && typeof sessionCwd === 'string' && sessionCwd.length > 0) path = resolve(sessionCwd, path)
  return path.replace(/\\/g, '/')
}

/**
 * One command as the shell reads it.
 *
 * The command body is sourced from a heredoc rather than written inline: an incomplete
 * construct in the body (an unclosed quote, `if` without `fi`, a here-document) would
 * otherwise swallow the epilogue that carries the end marker, and a command that reads
 * stdin would consume the protocol stream itself. The status line is written after the
 * heredoc, so it always runs.
 */
export function buildFrame(command, marker, workdir) {
  const body = workdir === undefined ? command : 'cd -- ' + shellQuote(workdir) + ' && ' + command
  return [
    "printf '\\n%s\\n' '" + marker.begin + "'",
    ". /dev/stdin <<'" + marker.end + "'",
    body,
    marker.end,
    '__dsh_ptc_bash_status=$?',
    "printf '\\n%s%d\\n' '" + marker.end + "' \"$__dsh_ptc_bash_status\"",
    '',
  ].join('\n')
}

/**
 * Recover one command's stdout and exit status from accumulated output.
 *
 * Returns undefined until both markers are present. The begin marker may already have slid
 * out of the collector's tail on a very chatty command: the end marker is the newest thing
 * the shell writes, so it is always retained, and a frame without its begin marker is
 * reported as a lost head instead of being discarded.
 */
export function parseFrame(text, marker) {
  const endIndex = text.lastIndexOf(marker.end)
  if (endIndex === -1) return undefined
  const status = /^(\d+)/.exec(text.slice(endIndex + marker.end.length))
  if (status === null) return undefined
  const beginIndex = text.indexOf(marker.begin)
  let start = 0
  if (beginIndex !== -1) {
    const newline = text.indexOf('\n', beginIndex)
    if (newline !== -1 && newline < endIndex) start = newline + 1
  }
  let stdout = text.slice(start, endIndex)
  if (stdout.endsWith('\n')) stdout = stdout.slice(0, -1)
  return { stdout, exitCode: Number(status[1]), frameStartFound: beginIndex !== -1 }
}

/**
 * Drop the frame's own leading marker lines from a partial capture.
 *
 * A capture capped to its tail can cut the begin marker itself, so a missing marker does
 * NOT mean the text is clean: the remains of that first line are dropped too, and the
 * caller is told the head was lost.
 */
export function framePartial(text, marker) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', lostHead: false }
  const begin = text.indexOf(marker.begin)
  if (begin !== -1) {
    const newline = text.indexOf('\n', begin)
    return newline === -1 ? { text: '', lostHead: false } : { text: text.slice(newline + 1), lostHead: false }
  }
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  const markerFragment = firstLine.includes(MARKER_PREFIX) || firstLine.includes('_begin')
  const rest = newline === -1 ? '' : text.slice(newline + 1)
  return { text: markerFragment ? rest : text, lostHead: true }
}

/** Keep the TAIL of `text` within `maxBytes`, at a UTF-8 boundary. */
export function truncateVisible(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false, lostHead: false }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return { text: bytes.subarray(start).toString('utf8'), truncated: true, lostHead: true }
}

function truncationLine(label, lostHead, spillPath) {
  const parts = [label + ' was truncated']
  if (lostHead) parts.push('the beginning was dropped')
  if (spillPath !== undefined) parts.push('full output: ' + spillPath)
  return '[' + parts.join('; ') + ']'
}

/** Shape one finished foreground run into the model-facing text. */
export function renderResult(result) {
  let body = result.stdout ?? ''
  if (result.stdoutTruncated === true) body = appendLine(body, truncationLine('output', result.stdoutLostHead === true, result.stdoutSpillPath))
  const stderr = result.stderr ?? ''
  if (stderr.length > 0 || result.stderrTruncated === true) {
    const parts = []
    if (stderr.length > 0) parts.push(stderr)
    if (result.stderrTruncated === true) parts.push(truncationLine('stderr', result.stderrLostHead === true, result.stderrSpillPath))
    body = appendLine(body, '[stderr]\n' + parts.join('\n'))
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut === true) markers.push('[timed out after ' + result.timeoutMs + 'ms; the shell was stopped, so the next call starts a fresh shell]')
  if (result.shellExited === true) markers.push('[shell exited; the next call starts a fresh shell]')
  if (result.signal !== null && result.signal !== undefined) markers.push('[killed by signal: ' + result.signal + ']')
  else if (result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0) markers.push('[exit code: ' + result.exitCode + ']')
  return markers.length === 0 ? body : appendLine(body, markers.join('\n'))
}

/** Map a settled background process onto the job-outcome vocabulary. */
export function processOutcome(outcome) {
  if (outcome.signal !== null && outcome.signal !== undefined) return { status: 'killed', detail: 'signal: ' + outcome.signal }
  return { status: 'completed', detail: 'exit code: ' + (outcome.exitCode ?? 0) }
}

/**
 * What this session's own sandbox policy allows.
 *
 * The SESSION goes into the request on purpose: the service ranks a session's own
 * `sandbox/mode` log above the deployment default, so a read without it would answer for
 * the deployment and could run under a mode the user restricted this session out of.
 *
 * @returns `{ verdict: 'serves' }` in `danger-full-access`; `{ verdict: 'refuses', mode? }`
 *   for any other mode, a missing session/directory, a throwing resolver, or a mode the
 *   service did not report; `{ verdict: 'unknown' }` when the deployment composes no
 *   policy service at all (the caller decides, see A1 in the task PRD).
 */
export function resolveServing(read, session) {
  if (read === undefined || read === null) return { verdict: 'unknown' }
  if (session === undefined || session === null) return { verdict: 'refuses', reason: 'no-session' }
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return { verdict: 'refuses', reason: 'no-cwd' }
  let mode
  try {
    mode = read.resolve({ session })?.mode
  } catch {
    return { verdict: 'refuses', reason: 'error' }
  }
  if (typeof mode !== 'string' || mode === '') return { verdict: 'refuses', reason: 'no-mode' }
  return mode === PREFERRED_SANDBOX_MODE ? { verdict: 'serves', mode } : { verdict: 'refuses', mode }
}

function sandboxMessage(gate) {
  const where = gate.mode === undefined ? 'this session' : 'this session (' + gate.mode + ' mode)'
  return 'SANDBOX_UNSUPPORTED: bash runs only in a danger-full-access session, and ' + where
    + ' cannot host the MSYS2 bash - it dies before `main` under a restricted token, so no command would run. '
    + 'Use the `pwsh` tool instead: it is the native shell for this platform, it is confined, and it stays on the tool surface whenever bash cannot serve the call.'
}

/** A tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    description: {
      type: 'string',
      description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" -> "List files in current directory"; "git status" -> "Show working tree status".',
    },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in milliseconds. On expiry the shell is stopped and the next call starts a fresh one.',
    },
    workdir: {
      type: 'string',
      description: 'Directory the persistent shell changes into before this command (`cd`), so later calls start there too. Defaults to the shell\'s current directory.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). Runs in its own process, not the session shell.',
    },
  },
  required: ['command', 'description'],
  additionalProperties: false,
}

/** The structured half of a result; `text` carries the rendered form. */
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    jobId: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    shellExited: { type: 'boolean' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
    stdoutLostHead: { type: 'boolean' },
    stderrLostHead: { type: 'boolean' },
    stdoutSpillPath: { type: 'string' },
    stderrSpillPath: { type: 'string' },
  },
  required: ['text'],
}

/** Register the model-facing `bash` tool. */
export function apply(ctx, config) {
  const explicitBashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : undefined
  const defaultTimeoutMs = positiveInteger(config?.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxTimeoutMs = Math.max(defaultTimeoutMs, positiveInteger(config?.maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS))
  const maxOutputBytes = positiveInteger(config?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const backgroundEnabled = config?.enableRunInBackground !== false

  /** Per-agent shell state: one persistent process plus its serial queue. */
  const states = new Map()
  let warnedNoPolicy = false
  let disposed = false

  const warnOnce = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // A missing logger must never turn a degraded path into a failure.
    }
  }

  const readPolicy = () => {
    if (typeof ctx.get === 'function') {
      try {
        const service = ctx.get('sandboxPolicy')
        if (service !== undefined) return service
      } catch {
        // Fall through to the direct service property.
      }
    }
    return ctx.sandboxPolicy
  }

  // The inferred executable is memoized per plugin instance: candidate probing
  // walks the filesystem, and the answer cannot change within a mount. A failed
  // inference is NOT memoized - the plain `bash` fallback resolves fresh on every
  // execute until some probe succeeds.
  let inferredShell
  const exists = (path) => access(path).then(() => true, () => false)
  const resolveShell = async (signal) => {
    if (explicitBashPath !== undefined) {
      // A misconfigured explicit path must fail as itself, not as a discovery
      // miss - the raw resolution error says which path failed.
      return ctx.subprocess.resolveExecutable(explicitBashPath, undefined, signal)
    }
    if (inferredShell !== undefined) return ctx.subprocess.resolveExecutable(inferredShell, undefined, signal)
    let gitExe
    try {
      gitExe = await ctx.subprocess.resolveExecutable('git', undefined, signal)
    } catch {
      // git unresolvable -> the env-derived candidates below still apply
    }
    for (const candidate of bashCandidates(process.env, gitExe)) {
      if (!(await exists(candidate))) continue
      try {
        inferredShell = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
        return inferredShell
      } catch {
        // Exists but unresolvable (EPERM, a broken scoop junction): keep
        // probing - one bad root must not block the rest of the chain, and
        // nothing is memoized so later executes can still find a good one.
        continue
      }
    }
    try {
      return await ctx.subprocess.resolveExecutable('bash', undefined, signal)
    } catch (error) {
      // Total discovery failure (no Git Bash root, no env root, no bash on
      // PATH): name the remedies instead of leaking a raw ENOENT. Never fall
      // back to pwsh/cmd here - the schema promises `bash -c` semantics; a
      // different shell would silently break every command.
      throw new Error('bash executable not found - install Git for Windows, expose a bash on PATH, or set the `bashPath` config (' + String((error && error.message) || error) + ')')
    }
  }

  // The slot the official `dsh-tool-bash` fills on POSIX (order 1000). On win32 that
  // row is disabled, so this plugin fills the same reservation with the rule the
  // tool description carries: bash first, pwsh when the task needs it.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Command-line work runs through the `bash` tool (Git Bash) on this machine by default - it is the preferred shell. Reach for `pwsh` only when the task specifically requires PowerShell. The shell keeps its state across calls in a session: `cd`, exported variables, functions and aliases survive; pass `workdir` to move it deliberately. A timeout or an abort stops the shell and the next call starts a fresh one. Non-zero exits are reported as `[exit code: N]` markers and timeouts as `[timed out after Nms]`; investigate failures before moving on. Long-running commands belong in the background: keep the job id and collect it with job_output.',
  })

  const abortError = () => {
    const error = new Error('tool call aborted')
    error.name = 'AbortError'
    return error
  }

  const delay = () => new Promise((done) => setTimeout(done, POLL_INTERVAL_MS))

  const writeFrame = (record, text) => {
    const stdin = record.handle.stdin
    if (stdin === undefined || stdin === null || typeof stdin.write !== 'function') {
      throw new Error('bash shell has no writable stdin: the subprocess provider did not open a pipe for this spawn')
    }
    stdin.write(text)
  }

  /**
   * Read from one stream until the frame completes.
   *
   * The collector keeps a bounded in-memory tail, so the frame is polled while the command
   * runs instead of read once at the end; the accumulated buffer is capped the same way and
   * the newest bytes are what it keeps. A frame whose begin marker was overtaken is still
   * recovered from its end marker and reported as a lost head.
   */
  const awaitFrame = async (record, marker, options) => {
    const deadline = Date.now() + options.timeoutMs
    let buffer = ''
    let overflow = false
    let spillPath
    for (;;) {
      let read
      try {
        read = record.handle.collected.stdout.readFrom(record.cursor.stdout)
      } catch (error) {
        const failure = new Error('bash output stream became unreadable: ' + String((error && error.message) || error))
        failure.code = 'SHELL_EXITED'
        failure.partial = buffer
        throw failure
      }
      record.cursor.stdout = read.nextOffset
      if (read.lossy === true) {
        overflow = true
        if (typeof read.spillPath === 'string') spillPath = read.spillPath
      }
      buffer += read.text
      if (buffer.length > options.cap) {
        buffer = buffer.slice(buffer.length - options.cap)
        overflow = true
      }
      const frame = parseFrame(buffer, marker)
      if (frame !== undefined) return { ...frame, overflow, spillPath }
      if (options.signal?.aborted === true) throw abortError()
      if (record.dead === true) {
        const failure = new Error('bash shell exited before this command finished')
        failure.code = 'SHELL_EXITED'
        failure.partial = buffer
        failure.overflow = overflow
        failure.spillPath = spillPath
        throw failure
      }
      if (Date.now() > deadline) {
        const failure = new Error('timed out after ' + options.timeoutMs + 'ms')
        failure.code = 'TIMEOUT'
        failure.partial = buffer
        failure.overflow = overflow
        failure.spillPath = spillPath
        throw failure
      }
      await delay()
    }
  }

  /** Start one persistent shell and prove the frame protocol works before returning it. */
  const startShell = async (exec) => {
    const shellPath = await resolveShell(exec?.signal)
    const cwd = exec?.agent?.session?.header?.cwd
    const shellEnv = collectShellEnv(ctx, exec)
    const handle = ctx.subprocess.spawn({
      argv: [shellPath, '--norc', '--noprofile', '-s'],
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: {
        stdin: 'pipe',
        stdout: { maxBytes: SHELL_TAIL_BYTES, spill: { maxBytes: SHELL_SPILL_BYTES } },
        stderr: { maxBytes: SHELL_STDERR_BYTES, spill: { maxBytes: SHELL_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      ...(shellEnv !== undefined ? { env: shellEnv } : {}),
    })
    const record = {
      handle,
      cursor: { stdout: 0, stderr: 0 },
      dead: false,
      outcome: undefined,
      shellPath,
    }
    Promise.resolve(handle.done).then(
      (outcome) => { record.outcome = outcome; record.dead = true },
      () => { record.dead = true },
    )
    try {
      const marker = markerFor()
      writeFrame(record, buildFrame('printf \'%s\\n\' "$BASH_VERSION"', marker))
      const frame = await awaitFrame(record, marker, { timeoutMs: START_TIMEOUT_MS, signal: exec?.signal, cap: 64 * 1024 })
      const version = frame.stdout.trim()
      if (version === '') throw new Error('bash answered the startup handshake with an empty version')
      record.version = version
      return record
    } catch (error) {
      try {
        handle.terminate?.()
      } catch {
        // A shell that cannot be terminated is reported by its own error.
      }
      const reason = error && error.code === 'TIMEOUT' ? 'timed out after ' + START_TIMEOUT_MS + 'ms' : String((error && error.message) || error)
      throw new Error('bash shell failed to start (' + reason + '); resolved shell: ' + String(shellPath))
    }
  }

  /** The live shell for one agent, starting one when absent or dead. */
  const ensureShell = async (state, exec) => {
    // A call that was still queued when its scope went away must not spawn a shell that
    // no registry tracks any more; only the subprocess provider would ever reap it.
    if (disposed === true || state.closed === true) throw new Error('the session shell was closed before this command could run')
    if (state.shell !== undefined && state.shell.dead !== true) return state.shell
    state.shell = undefined
    const record = await startShell(exec)
    state.shell = record
    return record
  }

  const terminateRecord = (record) => {
    if (record === undefined) return
    record.dead = true
    try {
      record.handle.terminate?.()
    } catch {
      // Termination is best effort; the provider owns the real teardown.
    }
  }

  const destroyShell = (state) => {
    const record = state.shell
    state.shell = undefined
    terminateRecord(record)
  }

  /** Run `work` with exclusive use of one agent's shell. */
  const serialize = async (agent, work) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { shell: undefined, queue: Promise.resolve() }
      states.set(agent, state)
    }
    const previous = state.queue
    let release
    state.queue = new Promise((done) => { release = done })
    await previous.catch(() => {})
    try {
      return await work(state)
    } finally {
      release()
    }
  }

  const readStderr = (record, from) => {
    try {
      const read = record.handle.collected.stderr.readFrom(from)
      record.cursor.stderr = read.nextOffset
      return {
        text: read.text,
        ...(read.lossy === true ? { lossy: true } : {}),
        ...(typeof read.spillPath === 'string' ? { spillPath: read.spillPath } : {}),
      }
    } catch {
      return { text: '' }
    }
  }

  /** Fold one frame plus stderr into the model-facing and structured result. */
  const finalize = (frame, limits) => {
    const stdout = truncateVisible(frame.stdout ?? '', limits.maxOutputBytes)
    const stderr = truncateVisible(frame.stderr ?? '', limits.maxOutputBytes)
    const stdoutTruncated = stdout.truncated || frame.overflow === true || frame.frameStartFound === false
    const stdoutLostHead = stdout.lostHead || frame.overflow === true || frame.frameStartFound === false
    const stderrTruncated = stderr.truncated || frame.stderrLossy === true
    const stderrLostHead = stderr.lostHead || frame.stderrLossy === true
    const result = {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: frame.exitCode ?? null,
      timedOut: frame.timedOut === true,
      shellExited: frame.shellExited === true,
      stdoutTruncated,
      stderrTruncated,
      stdoutLostHead,
      stderrLostHead,
      ...(frame.stdoutSpillPath !== undefined ? { stdoutSpillPath: frame.stdoutSpillPath } : {}),
      ...(frame.stderrSpillPath !== undefined ? { stderrSpillPath: frame.stderrSpillPath } : {}),
    }
    // `signal` and `timeoutMs` shape the text only: the output schema declares a closed
    // property set, so neither may travel in the structured value.
    return { text: renderResult({ ...result, signal: frame.signal ?? null, timeoutMs: frame.timeoutMs }), ...result }
  }

  /** One foreground command in the given shell state. */
  const runInShell = async (state, args, exec) => {
    const record = await ensureShell(state, exec)
    const marker = markerFor()
    const sessionCwd = exec?.agent?.session?.header?.cwd
    const workdir = args.workdir === undefined ? undefined : normalizeWorkdir(args.workdir, sessionCwd)
    const stderrFrom = record.cursor.stderr
    const timeoutMs = Math.min(args.timeoutMs !== undefined ? args.timeoutMs : defaultTimeoutMs, maxTimeoutMs)
    const cap = Math.max(maxOutputBytes * 4, 256 * 1024)
    writeFrame(record, buildFrame(args.command, marker, workdir))
    let frame
    try {
      frame = await awaitFrame(record, marker, { timeoutMs, signal: exec?.signal, cap })
    } catch (error) {
      if (error && error.code === 'TIMEOUT') {
        destroyShell(state)
        const capture = framePartial(error.partial, marker)
        const partial = truncateVisible(capture.text, cap)
        return finalize({
          stdout: partial.text,
          stderr: '',
          exitCode: null,
          timedOut: true,
          timeoutMs,
          overflow: error.overflow === true || capture.lostHead === true,
          frameStartFound: true,
        }, { maxOutputBytes })
      }
      if (error && error.code === 'SHELL_EXITED') {
        // The shell died before printing its end marker (`exit`, a crash, a wedge). Its
        // process outcome still tells the model what happened when the provider settled it.
        const outcome = record.outcome
        destroyShell(state)
        const capture = framePartial(error.partial, marker)
        const partial = truncateVisible(capture.text, cap)
        return finalize({
          stdout: partial.text,
          stderr: '',
          exitCode: outcome?.exitCode ?? null,
          signal: outcome?.signal ?? null,
          shellExited: true,
          overflow: error.overflow === true || capture.lostHead === true,
          frameStartFound: true,
        }, { maxOutputBytes })
      }
      if (error?.name === 'AbortError') {
        destroyShell(state)
        throw error
      }
      throw error
    }
    const stderr = readStderr(record, stderrFrom)
    return finalize({
      ...frame,
      stderr: stderr.text,
      ...(stderr.lossy === true ? { stderrLossy: true } : {}),
      ...(stderr.spillPath !== undefined ? { stderrSpillPath: stderr.spillPath } : {}),
    }, { maxOutputBytes })
  }

  /** A call with no owning agent cannot persist; give it a private shell and drop it. */
  const runTransient = async (args, exec) => {
    const state = { shell: undefined, queue: Promise.resolve() }
    try {
      return await runInShell(state, args, exec)
    } finally {
      destroyShell(state)
    }
  }

  const runBackground = async (args, exec) => {
    if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
    if (exec?.signal?.aborted === true) throw abortError()
    const jobs = (typeof ctx.get === 'function' ? ctx.get('jobs') : undefined) ?? ctx.jobs
    if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
    const shellPath = await resolveShell(exec?.signal)
    const workdir = resolveBackgroundWorkdir(args.workdir, exec)
    const shellEnv = collectShellEnv(ctx, exec)
    let stdoutOffset = 0
    let stderrOffset = 0
    const jobId = jobs.start({
      kind: 'bash',
      label: args.command,
      ...(exec?.agent !== undefined ? { owner: exec.agent } : {}),
      run: () => {
        const handle = ctx.subprocess.spawn({
          argv: [shellPath, '-c', args.command],
          ...(workdir !== undefined ? { cwd: workdir } : {}),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: maxOutputBytes },
            stderr: { maxBytes: maxOutputBytes },
          },
          graceMs: GRACE_MS,
          ...(shellEnv !== undefined ? { env: shellEnv } : {}),
        })
        const readDelta = (reader, offset, label) => {
          if (reader === undefined) return { text: '', offset, notice: undefined }
          const read = reader.readFrom(offset)
          const notice = read.lossy ? '[some ' + label + ' was dropped from memory; full output: ' + (read.spillPath ?? '(unavailable)') + ']' : undefined
          return { text: read.text, offset: read.nextOffset, notice }
        }
        return {
          cancel: () => handle.terminate(),
          done: handle.done.then((outcome) => processOutcome(outcome)),
          readOutput: () => {
            const parts = []
            const out = readDelta(handle.collected.stdout, stdoutOffset, 'output')
            stdoutOffset = out.offset
            if (out.text.length > 0) parts.push(out.text)
            if (out.notice !== undefined) parts.push(out.notice)
            const err = readDelta(handle.collected.stderr, stderrOffset, 'stderr')
            stderrOffset = err.offset
            if (err.text.length > 0) parts.push('[stderr]\n' + err.text)
            if (err.notice !== undefined) parts.push(err.notice)
            return parts.join('\n')
          },
        }
      },
    })
    return { text: 'started background job ' + jobId, jobId: String(jobId) }
  }

  const closeAgent = (agent) => {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    state.closed = true
    terminateRecord(state.shell)
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/disposed', ({ agent }) => { closeAgent(agent) })
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      for (const state of states.values()) {
        state.closed = true
        terminateRecord(state.shell)
      }
      states.clear()
    })
  }

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows). This is the PREFERRED shell on this machine: use it for all command-line work by default.',
      '* Use the `pwsh` tool only when the task specifically requires PowerShell - Windows services, the registry, COM/WMI, or a cmdlet with no bash equivalent. Do not choose pwsh merely because the host is Windows.',
      '* Shell state PERSISTS for this session: `cd`, exported variables, functions and aliases survive into the next call. Pass `workdir` to move the persistent shell before the command runs - it stays there for later calls too. A timeout or an abort stops the shell, and the next call starts a fresh one in the session directory.',
      '* This tool only runs in a danger-full-access session: the MSYS2 bash cannot start under a restricted token, so a restricted session is refused. Use `pwsh` there.',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* Network access is this host's: git, npm, curl and friends reach the network directly.",
      '* This is Git Bash (MINGW64), not a Linux container: there is no apt layer - install host tools with winget, scoop or npm.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output; output over the budget keeps the tail and reports where the full stream spilled.',
      '* Set `run_in_background: true` for long-running commands: it runs in its own process and returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.',
      '* Non-zero exits are reported as `[exit code: N]` markers - a marker is not an infrastructure failure; read the output and decide.',
      '* NOTE: this shell is not itself confined on Windows (the harness file sandbox covers the other file tools, not this shell), which is why it only serves danger-full-access sessions; treat output as untrusted.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      validateArgs(args)
      const session = exec?.agent?.session
      const gate = resolveServing(readPolicy(), session)
      if (gate.verdict === 'refuses') {
        if (exec?.agent !== undefined) closeAgent(exec.agent)
        throw new Error(sandboxMessage(gate))
      }
      if (gate.verdict === 'unknown' && !warnedNoPolicy) {
        warnedNoPolicy = true
        warnOnce(name + ': the deployment composes no sandbox-policy service, so the session mode cannot be enforced; bash runs with host authority')
      }
      if (args.run_in_background === true) return runBackground(args, exec)
      const agent = exec?.agent
      if (agent === undefined || agent === null) return runTransient(args, exec)
      return serialize(agent, (state) => runInShell(state, args, exec))
    },
  })
}

/** Resolve an explicit workdir first (relative ones against the session workspace). */
function resolveBackgroundWorkdir(modelWorkdir, exec) {
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}
