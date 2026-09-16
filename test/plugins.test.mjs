import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function settled(outcome, options = {}) {
  return {
    spawn: (spec) => ({
      spec,
      terminateCalls: 0,
      terminate() { this.terminateCalls += 1 },
      collected: {
        stdout: options.stdout ?? readerFrom('hello'),
        stderr: options.stderr ?? readerFrom(''),
      },
      done: Promise.resolve(outcome),
    }),
  }
}

function makeCtx(options = {}) {
  const registered = []
  const sections = []
  const spawns = []
  const ctx = {
    subprocess: {
      resolveExecutable: async (name) => 'C:/resolved/' + name,
      spawn: (spec) => {
        const built = (options.spawn ?? settled({ exitCode: 0, signal: null }).spawn)(spec)
        spawns.push(built)
        return built
      },
    },
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: (name) => (name === 'TOOL_BASH' ? 1000 : undefined),
    },
    get: (name) => (name === 'jobs' ? options.jobs : undefined),
  }
  return { ctx, registered, sections, spawns }
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

describe('dsh-bash-win', () => {
  it('registers the preferred bash tool and fills the official tool:bash slot', () => {
    const { ctx, registered, sections } = makeCtx()
    bashWin.apply(ctx, {})
    assert.equal(bashWin.name, 'dsh-bash-win')
    assert.ok(bashWin.inject.includes('systemPrompt'))
    assert.equal(registered.length, 1)
    const tool = registered[0]
    assert.equal(tool.name, 'bash')
    assert.match(tool.description, /PREFERRED shell on this machine/)
    assert.match(tool.description, /only when the task specifically requires PowerShell/)
    assert.match(tool.description, /Network access is this host/)
    assert.ok(!/apt and pip/.test(tool.description))
    assert.ok(!/access to the internet/.test(tool.description))
    assert.deepEqual(tool.parameters.required, ['command', 'description'])
    for (const key of ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background']) {
      assert.ok(tool.parameters.properties[key] !== undefined, 'schema carries ' + key)
    }
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'tool:bash')
    assert.equal(sections[0].order, 1000)
    assert.match(sections[0].text, /\[exit code: N\]/)
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

  it('runs a foreground command with the Git Bash argv, session cwd and bounded stdio', async () => {
    const { ctx, registered, spawns } = makeCtx()
    bashWin.apply(ctx, { maxOutputBytes: 4096 })
    const value = await registered[0].execute({ command: 'echo hi', description: 'Echo hi' }, exec('D:/ws'))
    assert.equal(value.text, 'hello')
    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].spec.argv.slice(1), ['-c', 'echo hi'])
    assert.equal(spawns[0].spec.cwd, 'D:/ws')
    assert.equal(spawns[0].spec.stdio.stdout.maxBytes, 4096)
    assert.equal(spawns[0].spec.graceMs, 3000)
  })

  it('reports a non-zero exit as a marker instead of an error', async () => {
    const { ctx, registered } = makeCtx({ spawn: settled({ exitCode: 7, signal: null }).spawn })
    bashWin.apply(ctx, {})
    const value = await registered[0].execute({ command: 'exit 7', description: 'Exit seven' }, exec())
    assert.match(value.text, /hello/)
    assert.match(value.text, /\[exit code: 7\]$/)
  })

  it('marks stderr, truncation and timeouts in the result text', async () => {
    const stderr = readerFrom('boom', { lossy: true, spillPath: 'C:/spill.txt' })
    const { ctx, registered } = makeCtx({ spawn: settled({ exitCode: 0, signal: null }, { stderr }).spawn })
    bashWin.apply(ctx, {})
    const value = await registered[0].execute({ command: 'boom', description: 'Boom' }, exec())
    assert.match(value.text, /\[stderr\]\nboom/)
    assert.match(value.text, /full output: C:\/spill.txt/)

    const onAbort = {
      spawn: (spec) => ({
        spec,
        terminateCalls: 0,
        terminate() {},
        collected: { stdout: readerFrom(''), stderr: readerFrom('') },
        done: new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        }),
      }),
    }
    const timeoutCtx = makeCtx({ spawn: onAbort.spawn })
    bashWin.apply(timeoutCtx.ctx, {})
    const timedOut = await timeoutCtx.registered[0].execute({ command: 'sleep 99', description: 'Sleep', timeoutMs: 20 }, exec())
    assert.match(timedOut.text, /\[timed out after 20ms\]/)
    assert.match(timedOut.text, /\[killed by signal: SIGTERM\]/)
  })

  it('resolves a relative workdir against the session workspace', async () => {
    const { ctx, registered, spawns } = makeCtx()
    bashWin.apply(ctx, {})
    await registered[0].execute({ command: 'ls', description: 'List', workdir: 'sub' }, exec('D:/ws'))
    assert.equal(spawns[0].spec.cwd, join('D:/ws', 'sub'))
  })

  it('starts a background job on the host jobs registry', async () => {
    const stdout = readerFrom('first')
    const jobs = backgroundJobs()
    const { ctx, registered, spawns } = makeCtx({ jobs, spawn: settled({ exitCode: 0, signal: null }, { stdout }).spawn })
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

  it('maps a signalled background process to a killed job outcome', async () => {
    const jobs = backgroundJobs()
    const { ctx, registered } = makeCtx({ jobs, spawn: settled({ exitCode: null, signal: 'SIGTERM' }).spawn })
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
