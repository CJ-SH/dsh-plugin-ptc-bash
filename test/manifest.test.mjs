/**
 * The manifest surface the Plugin Manager and the compatibility gate read.
 *
 * None of this is exercised by the other harnesses, and all of it is read WITHOUT
 * activating the plugin: the display metadata and the icon come from the manifest and
 * `locale/*.json` (`@deepseek-ai/dsh-app-boot`'s package-meta reader), and the peer range
 * is what decides at startup whether this row is admitted at all. A wrong icon path only
 * degrades the card; a wrong peer range denies the row, so both are pinned here.
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

/** Every path a manifest field promises: files, the shipped directories, and two globs. */
const claimed = [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch, ...manifest.files, ...Object.values(manifest.exports)]

/** The entries `files` ships as whole directories rather than as one file. */
const directories = new Set(['lib', 'presets', 'tools', 'LICENSES'])

/** One claimed path has to name something, whether it is a file, a directory or a glob. */
async function assertClaimed(entry) {
  const target = join(packageRoot, ...entry.replace(/^\.\//, '').split('/'))
  if (entry.includes('*')) {
    const pattern = basename(target)
    const names = await readdir(dirname(target))
    assert.ok(names.some((name) => (pattern.startsWith('*') ? name.endsWith(pattern.slice(1)) : name === pattern)), entry + ' matches something')
    return
  }
  const info = await stat(target)
  if (directories.has(entry)) assert.equal(info.isDirectory(), true, entry + ' is a directory')
  else assert.equal(info.isFile(), true, entry + ' is a file')
}

describe('manifest', () => {
  it('points every path it promises at something that exists', async () => {
    for (const entry of new Set(claimed)) await assertClaimed(entry)
  })

  it('declares an icon the reader accepts: relative, SVG, inside the package, small', async () => {
    const icon = manifest.icon
    assert.equal(typeof icon, 'string')
    assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/.test(icon) || icon.startsWith('/'), false, 'a relative path, never a URL')
    assert.equal(icon.endsWith('.svg'), true, 'SVG, PNG, JPEG or WebP')
    const file = join(packageRoot, icon)
    const info = await stat(file)
    assert.ok(info.size <= 256 * 1024, 'the reader refuses an icon above 256 KiB')
    assert.match(await readFile(file, 'utf8'), /^<svg[\s>]/, 'it parses as SVG')
  })

  it('carries display text in package.json meta and in both locales', async () => {
    for (const field of ['title', 'description']) {
      assert.ok(typeof manifest.meta?.[field] === 'string' && manifest.meta[field].length > 0, 'meta.' + field)
    }
    for (const language of ['en', 'zh']) {
      const file = join(packageRoot, 'locale', language + '.json')
      // The reader resolves `<specifier>/locale/<lang>.json`, so the file has to stay
      // reachable through the exports map as well as on disk.
      assert.ok(Object.hasOwn(manifest.exports, './locale/*.json'), 'the locale files are exported')
      assert.ok(manifest.files.includes('locale/*.json'), 'and shipped')
      const dictionary = JSON.parse(await readFile(file, 'utf8'))
      assert.ok(typeof dictionary.meta?.title === 'string' && dictionary.meta.title.length > 0, language + ': meta.title')
      assert.ok(typeof dictionary.meta?.description === 'string' && dictionary.meta.description.length > 0, language + ': meta.description')
    }
  })

  it('gates on the runtime it was written for, and on nothing else', () => {
    // Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are checked at startup, with
    // prereleases participating in the range; a range that does not accept the running
    // version denies the row. This package imports no harness package, so the runtime is
    // the whole dependency: the `agentPresets` service it injects belongs to it, and a
    // generation that renames the service fails this range first.
    assert.deepEqual(Object.keys(manifest.peerDependencies), ['@deepseek-ai/dsh'])
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '^0.2.0-rc.1')
  })
})
