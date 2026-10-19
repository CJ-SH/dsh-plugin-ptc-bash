import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'

const presetDir = join(fileURLToPath(new URL('..', import.meta.url)), 'presets', 'ptc-bash')
const bashWin = await import(pathToFileURL(join(presetDir, 'dsh-bash-win.mjs')).href)
const workspaceInstructions = await import(pathToFileURL(join(presetDir, 'workspace-instructions.mjs')).href)

const previousHome = process.env.DSH_HOME
const temps = []

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

function tempDir() {
  return mkdtemp(join(tmpdir(), 'ptc-bash-plugins-')).then((dir) => {
    temps.push(dir)
    return dir
  })
}

function readerFrom(text, options = {}) {
  let buffer = text
  return {
    append: (extra) => { buffer += extra },
    readFrom: (fromByte) => {
      const bytes = Buffer.from(buffer, 'utf8')
      const slice = bytes.subarray(Math.min(fromByte, bytes.length))
      return {
        text: slice.toString('utf8'),
        nextOffset: bytes.length,
        lossy: options.lossy === true,
        ...(options.spillPath === undefined ? {} : { spillPath: options.spillPath }),
      }
    },
  }
}

/**
 * A scripted `bash -s` stand-in.
 *
 * It answers the startup handshake and every command frame the tool writes, so the whole
 * persistent-shell protocol can be exercised without spawning a process. `onCommand` may
 * return the string `'silent'` to model a command that never completes (timeout/abort).
 */
function fakeShell(options = {}) {
  const stdout = readerFrom('')
  const stderr = readerFrom('')
  const writes = []
  let terminateCalls = 0
  let settled = false
  let resolveDone
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })
  const respond = (chunk) => {
    const begin = /__dsh_ptc_bash_[a-f0-9]+_begin/.exec(chunk)?.[0]
    const end = /__dsh_ptc_bash_[a-f0-9]+_end/.exec(chunk)?.[0]
    if (begin === undefined || end === undefined) return
    const lines = chunk.split('\n')
    const heredoc = lines.findIndex((line) => line.startsWith('. /dev/stdin'))
    const terminator = lines.indexOf(end)
    const body = lines.slice(heredoc + 1, terminator === -1 ? undefined : terminator).join('\n')
    if (body.includes('BASH_VERSION')) {
      stdout.append('\n' + begin + '\n5.2.9\n' + end + '0\n')
      return
    }
    const outcome = options.onCommand === undefined
      ? { stdout: options.stdout ?? 'hello', stderr: options.stderr ?? '', exitCode: options.exitCode ?? 0 }
      : options.onCommand(body)
    if (outcome === 'silent') return
    if (outcome !== null && typeof outcome === 'object' && 'exit' in outcome) {
      settled = true
      resolveDone({ exitCode: outcome.exit, signal: null })
      return
    }
    stdout.append('\n' + begin + '\n' + (outcome.stdout ?? '') + '\n' + end + String(outcome.exitCode ?? 0) + '\n')
    if ((outcome.stderr ?? '') !== '') stderr.append(outcome.stderr)
  }
  return {
    spec: undefined,
    get terminateCalls() { return terminateCalls },
    terminate() {
      terminateCalls += 1
      if (!settled) {
        settled = true
        resolveDone({ exitCode: null, signal: 'SIGTERM' })
      }
    },
    collected: { stdout, stderr },
    stdin: {
      write: (chunk) => {
        writes.push(chunk)
        respond(chunk)
      },
    },
    done,
    writes,
  }
}

function backgroundShell(outcome, options = {}) {
  const stdout = options.stdout ?? readerFrom('hello')
  const stderr = options.stderr ?? readerFrom('')
  let terminateCalls = 0
  return {
    spec: undefined,
    get terminateCalls() { return terminateCalls },
    terminate() { terminateCalls += 1 },
    collected: { stdout, stderr },
    done: Promise.resolve(outcome),
  }
}

function dangerAccess() {
  return { resolve: () => ({ mode: 'danger-full-access' }) }
}

function restricted(mode) {
  return { resolve: () => ({ mode }) }
}

function makeCtx(options = {}) {
  const registered = []
  const sections = []
  const spawns = []
  const handlers = new Map()
  const warnings = []
  const effects = []
  const ctx = {
    subprocess: {
      resolveExecutable: async (executable) => 'C:/resolved/' + executable,
      spawn: (spec) => {
        const shell = (options.spawn ?? (() => fakeShell(options.shellOptions)))(spec)
        shell.spec = spec
        spawns.push(shell)
        return shell
      },
    },
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: (order) => (order === 'TOOL_BASH' ? 1000 : undefined),
    },
    // The real composition always injects `shellEnv`; passing `shellEnv: null` models a
    // deployment without that service, which must degrade to "no overlay".
    ...(options.shellEnv === null
      ? {}
      : { shellEnv: options.shellEnv ?? { collect: () => ({ DSH_HOME: 'C:/Users/x/.dsh', DSH_SHELL: '1', DSH_SESSION_ID: 'session-test' }) } }),
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => {
      if (name === 'sandboxPolicy') return options.policy === null ? undefined : (options.policy ?? dangerAccess())
      if (name === 'jobs') return options.jobs
      return undefined
    },
    on: (event, handler) => { handlers.set(event, handler) },
    effect: (factory) => { effects.push(factory) },
  }
  return { ctx, registered, sections, spawns, handlers, warnings, effects }
}

function backgroundJobs() {
  const started = []
  return {
    started,
    start: (spec) => {
      started.push(spec)
      return 'bash-1'
    },
  }
}

const exec = (cwd = 'D:/ws') => ({ agent: { session: { header: { cwd } } } })

function framesOf(shell) {
  return shell.writes.filter((chunk) => chunk.includes('. /dev/stdin'))
}

describe('dsh-bash-win', () => {
  it('registers the preferred bash tool and fills the official tool:bash slot', () => {
    const { ctx, registered, sections } = makeCtx()
    bashWin.apply(ctx, {})
    assert.equal(bashWin.name, 'dsh-bash-win')
    assert.ok(bashWin.inject.includes('systemPrompt'))
    assert.ok(bashWin.inject.includes('shellEnv'))
    assert.equal(registered.length, 1)
    const tool = registered[0]
    assert.equal(tool.name, 'bash')
    assert.match(tool.description, /PREFERRED shell on this machine/)
    assert.match(tool.description, /only when the task specifically requires PowerShell/)
    assert.match(tool.description, /Network access is this host/)
    assert.match(tool.description, /Shell state PERSISTS/)
    assert.ok(!/State does NOT persist/.test(tool.description))
    assert.deepEqual(tool.parameters.required, ['command', 'description'])
    for (const key of ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background']) {
      assert.ok(tool.parameters.properties[key] !== undefined, 'schema carries ' + key)
    }
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'tool:bash')
    assert.equal(sections[0].order, 1000)
    assert.match(sections[0].text, /\[exit code: N\]/)
    assert.match(sections[0].text, /state across calls/i)
  })

  it('rejects malformed arguments like the official shell tools', async () => {
    const { ctx, registered } = makeCtx()
    bashWin.apply(ctx, {})
    const tool = registered[0]
    await assert.rejects(() => tool.execute({ command: '  ', description: 'x' }, exec()), /invalid command/)
    await assert.rejects(() => tool.execute({ command: 'ls' }, exec()), /invalid description/)
    await assert.rejects(() => tool.execute({ command: 'ls', description: 'x', timeoutMs: -1 }, exec()), /invalid timeoutMs/)
    await assert.rejects(() => tool.execute({ command: 'ls', description: 'x', run_in_background: 'yes' }, exec()), /invalid run_in_background/)
  })

  it('refuses a session outside danger-full-access without spawning', async () => {
    const { ctx, registered, spawns } = makeCtx({ policy: restricted('workspace-write') })
    bashWin.apply(ctx, {})
    await assert.rejects(
      () => registered[0].execute({ command: 'ls', description: 'List' }, exec()),
      /SANDBOX_UNSUPPORTED: bash runs only in a danger-full-access session.*workspace-write mode/,
    )
    assert.equal(spawns.length, 0)
  })

  it('serves a deployment that composes no sandbox-policy service, warning once', async () => {
    const { ctx, registered, spawns, warnings } = makeCtx({ policy: null })
    bashWin.apply(ctx, {})
    const execCtx = exec()
    const first = await registered[0].execute({ command: 'echo hi', description: 'Echo hi' }, execCtx)
    await registered[0].execute({ command: 'echo hi', description: 'Echo hi' }, execCtx)
    assert.equal(first.stdout, 'hello')
    assert.equal(spawns.length, 1)
    assert.equal(warnings.filter((message) => /sandbox-policy service/.test(message)).length, 1)
  })

  it('keeps one persistent shell per session and reuses it across calls', async () => {
    const { ctx, registered, spawns } = makeCtx()
    bashWin.apply(ctx, {})
    const execCtx = exec()
    const first = await registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx)
    const second = await registered[0].execute({ command: 'export A=1', description: 'Export' }, execCtx)
    assert.equal(spawns.length, 1, 'one shell process for both calls')
    assert.deepEqual(spawns[0].spec.argv, ['C:/resolved/bash', '--norc', '--noprofile', '-s'])
    assert.equal(spawns[0].spec.stdio.stdin, 'pipe')
    assert.equal(spawns[0].spec.cwd, 'D:/ws')
    assert.equal(spawns[0].spec.graceMs, 3000)
    const frames = framesOf(spawns[0])
    assert.equal(frames.length, 3, 'handshake plus two commands')
    assert.match(frames[1], /\npwd\n/)
    assert.match(frames[2], /\nexport A=1\n/)
    assert.equal(first.stdout, 'hello')
    assert.equal(second.stdout, 'hello')
  })

  it('writes workdir as a persistent cd inside the same shell', async () => {
    const { ctx, registered, spawns } = makeCtx()
    bashWin.apply(ctx, {})
    const execCtx = exec('D:/ws')
    await registered[0].execute({ command: 'ls', description: 'List', workdir: 'sub' }, execCtx)
    const expected = bashWin.normalizeWorkdir('sub', 'D:/ws')
    assert.equal(expected, resolve('D:/ws', 'sub').replace(/\\/g, '/'))
    const frames = framesOf(spawns[0])
    assert.ok(frames[1].includes("cd -- '" + expected + "' && ls"), frames[1])
    const second = await registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx)
    assert.equal(spawns.length, 1, 'workdir did not restart the shell')
    assert.equal(second.stdout, 'hello')
  })

  it('stops the shell on timeout and starts a fresh one on the next call', async () => {
    let commands = 0
    const shellOptions = {
      onCommand: (body) => {
        if (body.includes('BASH_VERSION')) return { stdout: '5.2.9', exitCode: 0 }
        commands += 1
        return commands === 1 ? 'silent' : { stdout: 'fresh', exitCode: 0 }
      },
    }
    const { ctx, registered, spawns } = makeCtx({ shellOptions })
    bashWin.apply(ctx, {})
    const timedOut = await registered[0].execute({ command: 'sleep 99', description: 'Sleep', timeoutMs: 30 }, exec())
    assert.equal(timedOut.timedOut, true)
    assert.match(timedOut.text, /\[timed out after 30ms; the shell was stopped/)
    assert.equal(spawns[0].terminateCalls, 1)
    const next = await registered[0].execute({ command: 'pwd', description: 'Print dir' }, exec())
    assert.equal(spawns.length, 2, 'a dead shell is replaced')
    assert.equal(next.stdout, 'fresh')
  })

  it('reports a timeout-free non-zero exit as a marker', async () => {
    const { ctx, registered } = makeCtx({ shellOptions: { stdout: 'boom', exitCode: 7 } })
    bashWin.apply(ctx, {})
    const value = await registered[0].execute({ command: 'exit 7', description: 'Exit seven' }, exec())
    assert.equal(value.exitCode, 7)
    assert.match(value.text, /boom/)
    assert.match(value.text, /\[exit code: 7\]$/)
  })

  it('marks stderr and keeps the structured result fields', async () => {
    const { ctx, registered } = makeCtx({ shellOptions: { stdout: 'out', stderr: 'boom', exitCode: 0 } })
    bashWin.apply(ctx, {})
    const value = await registered[0].execute({ command: 'boom', description: 'Boom' }, exec())
    assert.match(value.text, /\[stderr\]\nboom/)
    assert.equal(value.stdout, 'out')
    assert.equal(value.stderr, 'boom')
    assert.equal(value.exitCode, 0)
    assert.equal(value.timedOut, false)
    assert.equal(value.shellExited, false)
    assert.equal(value.stdoutTruncated, false)
    assert.equal(value.stderrTruncated, false)
    // The declared output schema is a closed property set: anything added here without a
    // matching declaration is rejected by the runtime's output validation.
    assert.deepEqual(Object.keys(value).sort(), [
      'exitCode', 'shellExited', 'stderr', 'stderrLostHead', 'stderrTruncated',
      'stdout', 'stdoutLostHead', 'stdoutTruncated', 'text', 'timedOut',
    ])
    assert.equal('signal' in value, false, 'signal only shapes the text markers')
  })

  it('reports a command that exits the shell, and rebuilds on the next call', async () => {
    const shellOptions = {
      onCommand: (body) => (body.includes('BASH_VERSION') ? { stdout: '5.2.9', exitCode: 0 } : { exit: 7 }),
    }
    const { ctx, registered, spawns } = makeCtx({ shellOptions })
    bashWin.apply(ctx, {})
    const execCtx = exec()
    const value = await registered[0].execute({ command: 'exit 7', description: 'Exit seven' }, execCtx)
    assert.equal(value.shellExited, true)
    assert.equal(value.exitCode, 7)
    assert.match(value.text, /\[shell exited; the next call starts a fresh shell\]/)
    assert.match(value.text, /\[exit code: 7\]/)
    assert.ok(!value.stdout.includes('__dsh_ptc_bash_'), 'frame markers never reach the model')
    await registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx)
    assert.equal(spawns.length, 2, 'the dead shell is replaced')
  })

  it('aborts the call and stops the shell when the tool call is cancelled', async () => {
    const shellOptions = {
      onCommand: (body) => (body.includes('BASH_VERSION') ? { stdout: '5.2.9', exitCode: 0 } : 'silent'),
    }
    const { ctx, registered, spawns } = makeCtx({ shellOptions })
    bashWin.apply(ctx, {})
    const controller = new AbortController()
    const execCtx = { ...exec(), signal: controller.signal }
    const pending = registered[0].execute({ command: 'sleep 99', description: 'Sleep' }, execCtx)
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(() => pending, /tool call aborted/)
    assert.equal(spawns[0].terminateCalls, 1)
  })

  it('passes the current execution DSH_* overlay through the shell spawn', async () => {
    const overlay = { DSH_HOME: 'C:/Users/x/.dsh', DSH_SHELL: '1', DSH_SESSION_ID: 'session-abc' }
    const calls = []
    const { ctx, registered, spawns } = makeCtx({ shellEnv: { collect: (current) => { calls.push(current); return overlay } } })
    bashWin.apply(ctx, {})
    const execCtx = exec()
    await registered[0].execute({ command: 'echo hi', description: 'Echo hi' }, execCtx)
    assert.equal(calls.length, 1)
    assert.equal(calls[0], execCtx, 'collect receives this execution, not a placeholder')
    assert.deepEqual(spawns[0].spec.env, overlay)
  })

  it('omits env - and still runs the command - when the overlay is unavailable', async () => {
    const cases = [
      ['no shell-env service', null],
      ['collect throws', { collect: () => { throw new Error('registry exploded') } }],
      ['empty overlay', { collect: () => ({}) }],
      ['non-object overlay', { collect: () => 'nope' }],
    ]
    for (const [label, shellEnv] of cases) {
      const { ctx, registered, spawns } = makeCtx({ shellEnv })
      bashWin.apply(ctx, {})
      const value = await registered[0].execute({ command: 'echo hi', description: 'Echo hi' }, exec())
      assert.equal(value.stdout, 'hello', label + ': shell still runs')
      assert.equal(Object.hasOwn(spawns[0].spec, 'env'), false, label + ': no env key')
    }
  })

  it('starts a background job in its own process on the host jobs registry', async () => {
    const stdout = readerFrom('first')
    const jobs = backgroundJobs()
    const { ctx, registered, spawns } = makeCtx({
      jobs,
      spawn: (spec) => backgroundShell({ exitCode: 0, signal: null }, { stdout }),
    })
    bashWin.apply(ctx, {})
    const execCtx = exec()
    const value = await registered[0].execute({ command: 'npm test', description: 'Run tests', run_in_background: true }, execCtx)
    assert.equal(value.jobId, 'bash-1')
    assert.match(value.text, /started background job bash-1/)
    assert.equal(jobs.started.length, 1)
    assert.equal(jobs.started[0].kind, 'bash')
    assert.equal(jobs.started[0].label, 'npm test')
    assert.equal(jobs.started[0].owner, execCtx.agent)
    const hooks = jobs.started[0].run()
    assert.equal(typeof hooks.cancel, 'function')
    assert.equal(typeof hooks.readOutput, 'function')
    assert.equal(hooks.readOutput(), 'first')
    stdout.append('second')
    assert.equal(hooks.readOutput(), 'second')
    hooks.cancel()
    assert.equal(spawns[0].terminateCalls, 1)
    assert.deepEqual(await hooks.done, { status: 'completed', detail: 'exit code: 0' })
  })

  it('runs background commands through their own bash -c, never the session shell', async () => {
    const jobs = backgroundJobs()
    const { ctx, registered, spawns } = makeCtx({
      jobs,
      spawn: () => backgroundShell({ exitCode: 0, signal: null }),
    })
    bashWin.apply(ctx, {})
    await registered[0].execute({ command: 'npm test', description: 'Run tests', run_in_background: true }, exec('D:/ws'))
    jobs.started[0].run()
    assert.deepEqual(spawns[0].spec.argv, ['C:/resolved/bash', '-c', 'npm test'])
    assert.equal(spawns[0].spec.cwd, 'D:/ws')
  })

  it('maps a signalled background process to a killed job outcome', async () => {
    const jobs = backgroundJobs()
    const { ctx, registered } = makeCtx({
      jobs,
      spawn: () => backgroundShell({ exitCode: null, signal: 'SIGTERM' }),
    })
    bashWin.apply(ctx, {})
    await registered[0].execute({ command: 'sleep 1', description: 'Sleep', run_in_background: true }, exec())
    const hooks = jobs.started[0].run()
    assert.deepEqual(await hooks.done, { status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('refuses background runs without the jobs runtime or when disabled', async () => {
    const withoutJobs = makeCtx()
    bashWin.apply(withoutJobs.ctx, {})
    await assert.rejects(
      () => withoutJobs.registered[0].execute({ command: 'ls', description: 'List', run_in_background: true }, exec()),
      /background jobs unavailable/,
    )
    const disabled = makeCtx({ jobs: backgroundJobs() })
    bashWin.apply(disabled.ctx, { enableRunInBackground: false })
    await assert.rejects(
      () => disabled.registered[0].execute({ command: 'ls', description: 'List', run_in_background: true }, exec()),
      /run_in_background is disabled/,
    )
  })

  it('stops one session shell when its agent is disposed', async () => {
    const { ctx, registered, spawns, handlers } = makeCtx()
    bashWin.apply(ctx, {})
    const execCtx = exec()
    await registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx)
    handlers.get('agent/disposed')({ agent: execCtx.agent })
    assert.equal(spawns[0].terminateCalls, 1)
  })

  it('closes its shell and refuses new work when the plugin is disposed', async () => {
    const { ctx, registered, spawns, effects } = makeCtx()
    bashWin.apply(ctx, {})
    const execCtx = exec()
    await registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx)
    const dispose = effects[0]()
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(spawns[0].terminateCalls, 1)
    await assert.rejects(
      () => registered[0].execute({ command: 'pwd', description: 'Print dir' }, execCtx),
      /session shell was closed before this command could run/,
    )
    assert.equal(spawns.length, 1, 'a disposed plugin never spawns another shell')
  })

  it('builds frames that survive multi-line commands and parses their frames', () => {
    const marker = bashWin.markerFor()
    const frame = bashWin.buildFrame('printf "a\\nb\\n"', marker)
    assert.ok(frame.includes(". /dev/stdin <<'" + marker.end + "'"))
    assert.ok(frame.includes('\nprintf "a\\nb\\n"\n'))
    assert.ok(frame.includes("printf '\\n%s%d\\n' '" + marker.end + "' \"$__dsh_ptc_bash_status\""))
    const parsed = bashWin.parseFrame('\n' + marker.begin + '\na\nb\n' + marker.end + '0\n', marker)
    assert.deepEqual(parsed, { stdout: 'a\nb', exitCode: 0, frameStartFound: true })
    const headLost = bashWin.parseFrame('b\n' + marker.end + '3\n', marker)
    assert.deepEqual(headLost, { stdout: 'b', exitCode: 3, frameStartFound: false })
    assert.equal(bashWin.parseFrame('\nstray output\n', marker), undefined)
  })

  it('strips frame markers from a partial capture and reports a lost head', () => {
    const marker = bashWin.markerFor()
    assert.deepEqual(bashWin.framePartial('x' + marker.begin + '\nout\n', marker), { text: 'out\n', lostHead: false })
    assert.deepEqual(bashWin.framePartial('c0ffee_begin\nout', marker), { text: 'out', lostHead: true })
    assert.deepEqual(bashWin.framePartial('plain output', marker), { text: 'plain output', lostHead: true })
    assert.deepEqual(bashWin.framePartial('', marker), { text: '', lostHead: false })
  })

  it('keeps the tail of an over-budget output at a UTF-8 boundary', () => {
    const value = bashWin.truncateVisible('héllo', 4)
    assert.equal(value.truncated, true)
    assert.equal(value.lostHead, true)
    assert.equal(value.text, 'llo')
    assert.deepEqual(bashWin.truncateVisible('hi', 4), { text: 'hi', truncated: false, lostHead: false })
  })
})

describe('workspace-instructions', () => {
  it('discovers the instruction chain and renders it into one section', async () => {
    const home = await tempDir()
    const project = join(home, 'project')
    const nested = join(project, 'sub')
    await mkdir(nested, { recursive: true })
    await writeFile(join(home, 'AGENTS.md'), 'user rules')
    await writeFile(join(project, '.git'), '')
    await writeFile(join(project, 'AGENTS.md'), 'root rules')
    await writeFile(join(nested, 'AGENTS.md'), 'sub rules')
    const files = await workspaceInstructions.discoverInstructionFiles(nested, { DSH_HOME: home })
    const display = files.map((file) => file.displayPath)
    assert.ok(display.includes('AGENTS.md'))
    assert.ok(display.includes(join('sub', 'AGENTS.md')))
    assert.equal(files[0].absolutePath, join(home, 'AGENTS.md'))
    const loaded = await workspaceInstructions.loadInstructionFiles(nested, { DSH_HOME: home })
    const text = workspaceInstructions.renderInstructionSection(loaded, 65536)
    assert.match(text, /AGENTS\.md-style/)
    assert.match(text, /root rules/)
    assert.match(text, /sub rules/)
  })

  it('rewrites the official baseline injection into a marker and keeps everything else', async () => {
    const home = await tempDir()
    const project = join(home, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, '.git'), '')
    await writeFile(join(project, 'AGENTS.md'), 'root rules')
    const loaded = await workspaceInstructions.loadInstructionFiles(project, { DSH_HOME: home })
    const messages = [
      { id: 'baseline', content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\nroot rules' }], source: { kind: 'agent-instructions', baseline: true } },
      { id: 'user', content: [{ type: 'text', text: 'please fix the bug' }] },
      { id: 'dynamic', content: [{ type: 'text', text: 'Additional Instructions from: deep/AGENTS.md\n\ndeep rules' }], source: { kind: 'agent-instructions' } },
    ]
    const kept = workspaceInstructions.filterInstructionMessages(messages, loaded, true, { session: { header: { cwd: project } } })
    assert.equal(kept.length, 3)
    assert.deepEqual(kept[1], messages[1])
    assert.equal(kept[2], messages[2])
    assert.match(kept[0].content[0].text, /active in the system prompt/)
    assert.ok(!kept[0].content[0].text.includes('root rules'))
  })

  it('appends its section and assembly variable without dropping any official section', async () => {
    const home = await tempDir()
    const project = join(home, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, '.git'), '')
    await writeFile(join(project, 'AGENTS.md'), 'root rules')
    process.env.DSH_HOME = home
    const handlers = new Map()
    const ctx = {
      on: (event, handler) => handlers.set(event, handler),
      logger: { warn: () => {} },
    }
    workspaceInstructions.apply(ctx, { instructionMaxBytes: 65536 })
    const assembly = {
      sections: [
        { name: 'persona', text: 'You are a coding agent.' },
        { name: 'harness:identity', text: 'Harness identity.' },
        { name: 'tools:sdk', text: 'SDK.' },
      ],
      variables: {},
    }
    const assemble = handlers.get('system-prompt/assemble')
    const out = await assemble(assembly, { agent: { session: { header: { cwd: project } } } }, async () => assembly)
    assert.equal(out.sections.length, 4)
    assert.equal(workspaceInstructions.name, 'workspace-instructions')
    assert.ok(workspaceInstructions.inject.includes('systemPrompt'))
    assert.deepEqual(out.sections.slice(0, 3), assembly.sections)
    assert.equal(out.sections[3].name, 'workspace-instructions')
    assert.equal(out.sections[3].text, '{{workspace_instructions}}')
    assert.match(out.variables.workspace_instructions, /root rules/)
  })
})
