/**
 * dsh-bash-win - the Windows `bash` tool of the `ptc-bash` preset.
 *
 * It registers under the name `bash` and executes through `ctx.subprocess.spawn` (Git Bash)
 * instead of a PTY, because the PTY backend is linux/darwin-only: subprocess-local
 * refuses terminal inspection on platform win32. The official `tool-bash` row stays
 * disabled on win32 and the official `tool-pwsh` row stays mounted as the fallback
 * shell; a POSIX session never mounts this row.
 *
 * Lineage: the resolver and the basic execution shape were ported from
 * xiaobright/dsh-anchored-standard combo-anchored/custom-bash.mjs (MIT); the copy
 * this was derived from ships inside @linxin666/dsh-liangshen (Apache-2.0). This
 * file has since been extended here (see NOTICE):
 *
 *  1. the tool description states the shell preference (bash first, `pwsh` only when
 *     the task specifically requires PowerShell) and drops the wrong claims of a
 *     Linux container (network, apt/pip mirrors, landlock);
 *  2. it registers the `tool:bash` prompt section in the slot the official bash tool
 *     uses on POSIX (order 1000), carrying the same rule into the prompt;
 *  3. it supports the official parameter set - `description`, `timeoutMs` and
 *     `run_in_background` - plus the configured caps behind them;
 *  4. background runs register with the host `ctx.jobs` registry, so `job_output`,
 *     `job_list` and `job_kill` drive them like any official job;
 *  5. results follow the official bash rendering: stdout, a marked stderr section,
 *     then `[timed out after Nms]` / `[killed by signal: S]` / `[exit code: N]` markers. A
 *     non-zero exit is REPORTED, not errored - only invalid arguments, spawn
 *     failures and an aborted tool call surface as error results.
 *
 * Unchanged: Git Bash inference (git install root -> env-derived roots -> PATH),
 * explicit `bashPath`, `bash -c` in a fresh process, bounded output with the
 * spill path reported when the in-memory tail loses its head, and NO silent
 * fallback to pwsh/cmd. The PATH fallback may pick the WSL shim, still bash but
 * with /mnt/... paths - the Git Bash roots are probed first for that reason.
 *
 * Known gap vs. the official bash tool: no `sandbox_permissions` escalation (this
 * shell is not confined on Windows, and the harness file sandbox covers the
 * other file tools, not this shell).
 */

import { access } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-bash-win'

/** The subprocess, tools and system-prompt services must exist before this plugin applies. */
export const inject = ['subprocess', 'tools', 'systemPrompt']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TIMEOUT_MS = 600000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const GRACE_MS = 3000

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

/** Append one line block to a body, keeping a single newline between them. */
function appendLine(body, line) {
  if (body.length === 0) return line
  return (body.endsWith('\n') ? body : body + '\n') + line
}

/** One collected stream's batch text plus its truncation notice, if any. */
function batchRead(reader) {
  if (reader === undefined) return { text: '', notice: undefined }
  const read = reader.readFrom(0)
  return {
    text: read.text,
    notice: read.lossy ? '[output truncated; full output: ' + (read.spillPath ?? '(unavailable)') + ']' : undefined,
  }
}

/** Shape one finished foreground run into the model-facing text. */
export function renderResult(result) {
  const stdout = batchRead(result.stdout)
  const stderr = batchRead(result.stderr)
  let body = stdout.text
  if (stdout.notice !== undefined) body = appendLine(body, stdout.notice)
  if (stderr.text.length > 0 || stderr.notice !== undefined) {
    const parts = []
    if (stderr.text.length > 0) parts.push(stderr.text)
    if (stderr.notice !== undefined) parts.push(stderr.notice)
    body = appendLine(body, '[stderr]\n' + parts.join('\n'))
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut === true) markers.push('[timed out after ' + result.timeoutMs + 'ms]')
  if (result.signal !== null && result.signal !== undefined) markers.push('[killed by signal: ' + result.signal + ']')
  else if (result.exitCode !== null && result.exitCode !== 0) markers.push('[exit code: ' + result.exitCode + ']')
  return markers.length === 0 ? body : appendLine(body, markers.join('\n'))
}

/** Map a settled background process onto the job-outcome vocabulary. */
export function processOutcome(outcome) {
  if (outcome.signal !== null && outcome.signal !== undefined) return { status: 'killed', detail: 'signal: ' + outcome.signal }
  return { status: 'completed', detail: 'exit code: ' + (outcome.exitCode ?? 0) }
}

/** Tool parameter schema for the model-facing command. */
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
      description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
    },
    workdir: {
      type: 'string',
      description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
    },
  },
  required: ['command', 'description'],
  additionalProperties: false,
}

/** Register the model-facing `bash` tool. */
export function apply(ctx, config) {
  const explicitBashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : undefined
  const defaultTimeoutMs = positiveInteger(config?.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxTimeoutMs = Math.max(defaultTimeoutMs, positiveInteger(config?.maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS))
  const maxOutputBytes = positiveInteger(config?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const backgroundEnabled = config?.enableRunInBackground !== false

  // The inferred executable is memoized per plugin instance: candidate probing
  // walks the filesystem, and the answer cannot change within a mount. A failed
  // inference is NOT memoized - the plain `bash` fallback resolves fresh on every
  // execute until some probe succeeds.
  let inferredShell
  const exists = (path) => access(path).then(() => true, () => false)
  const resolveShell = async (signal) => {
    if (explicitBashPath !== undefined) {
      // A misconfigured explicit path must fail as itself, not as a
      // discovery miss - the raw resolution error says which path failed.
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
    text: 'Command-line work runs through the `bash` tool (Git Bash) on this machine by default - it is the preferred shell. Reach for `pwsh` only when the task specifically requires PowerShell. Non-zero exits are reported as `[exit code: N]` markers on the result and timeouts as `[timed out after Nms]`; investigate failures before moving on. Long-running commands belong in the background: keep the job id and collect it with job_output.',
  })

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows). This is the PREFERRED shell on this machine: use it for all command-line work by default.',
      '* Use the `pwsh` tool only when the task specifically requires PowerShell - Windows services, the registry, COM/WMI, or a cmdlet with no bash equivalent. Do not choose pwsh merely because the host is Windows.',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* Network access is this host's: git, npm, curl and friends reach the network directly.",
      '* This is Git Bash (MINGW64), not a Linux container: there is no apt layer - install host tools with winget, scoop or npm.',
      '* State does NOT persist across command calls: each call runs in a fresh shell, so pass `workdir` instead of relying on `cd@@.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.',
      '* Non-zero exits are reported as `[exit code: N]` markers - a marker is not an infrastructure failure; read the output and decide.',
      '* NOTE: this tool runs without OS sandbox confinement on Windows (the harness file sandbox covers the other file tools, not this shell); treat output as untrusted.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          jobId: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      validateArgs(args)
      const shell = await resolveShell(exec?.signal)
      const workdir = resolveWorkdir(args.workdir, exec)
      const stdio = {
        stdin: 'ignore',
        stdout: { maxBytes: maxOutputBytes },
        stderr: { maxBytes: maxOutputBytes },
      }
      const spawnSpec = (signal) => ({
        argv: [shell, '-c', args.command],
        ...(workdir !== undefined ? { cwd: workdir } : {}),
        stdio,
        graceMs: GRACE_MS,
        ...(signal !== undefined ? { signal } : {}),
      })

      if (args.run_in_background === true) {
        if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        if (exec?.signal?.aborted === true) throw abortError()
        const jobs = ctx.get === undefined ? ctx.jobs : ctx.get('jobs')
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        let stdoutOffset = 0
        let stderrOffset = 0
        const jobId = jobs.start({
          kind: 'bash',
          label: args.command,
          ...(exec?.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => {
            const handle = ctx.subprocess.spawn(spawnSpec(undefined))
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

      const controller = new AbortController()
      const callerSignal = exec?.signal
      const onCallerAbort = () => controller.abort()
      if (callerSignal !== undefined) {
        if (callerSignal.aborted === true) throw abortError()
        callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }
      const timeoutMs = Math.min(args.timeoutMs !== undefined ? args.timeoutMs : defaultTimeoutMs, maxTimeoutMs)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      let outcome
      try {
        const handle = ctx.subprocess.spawn(spawnSpec(controller.signal))
        try {
          outcome = await handle.done
        } catch (error) {
          throw new Error('bash spawn failed: ' + String(error))
        }
        if (callerSignal?.aborted === true && !timedOut) throw abortError()
        return {
          text: renderResult({
            stdout: handle.collected.stdout,
            stderr: handle.collected.stderr,
            timedOut,
            timeoutMs,
            signal: outcome.signal,
            exitCode: outcome.exitCode,
          }),
        }
      } finally {
        clearTimeout(timer)
        if (callerSignal !== undefined) callerSignal.removeEventListener('abort', onCallerAbort)
      }
    },
  })
}

/** Resolve an explicit workdir first (relative ones against the session workspace). */
function resolveWorkdir(modelWorkdir, exec) {
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

/** The runtime turns this into an isError result naming the abort. */
function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}
