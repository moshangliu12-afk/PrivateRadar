import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 只核验构建依赖的官方 Mac 运行时，不接触 WorkBuddy；不替换已安装文件。
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('electron/package.json'))
const version = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8')).version
assert.equal(version, '44.10.0')
const locked = JSON.parse(await fs.readFile('package-lock.json', 'utf8')).packages['node_modules/electron']
assert.equal(locked.version, version)
const archive = `electron-v${version}-darwin-arm64.zip`
const checksums = JSON.parse(await fs.readFile(join(packageRoot, 'checksums.json'), 'utf8'))
const expected = checksums[archive]
assert.equal(expected, '8e9f6041d3aa62229332b033d0390fd213a9b10cd078163f3f5fe988ee91baf7')
try { await fs.access(join(packageRoot, 'dist')) } catch {
  const environment = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[name] !== undefined) environment[name] = process.env[name]
  Object.assign(environment, { ELECTRON_INSTALL_PLATFORM: 'darwin', ELECTRON_INSTALL_ARCH: 'arm64' })
  execFileSync(process.execPath, [join(packageRoot, 'install.js')], { env: environment, timeout: 600000, maxBuffer: 1048576 })
}
const temporary = await fs.mkdtemp(join(process.env.RUNNER_TEMP, 'privateradar-m2a-runtime-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const source = `https://github.com/electron/electron/releases/download/v${version}/${archive}`
  const response = await fetch(source, { signal: AbortSignal.timeout(180000) })
  assert.equal(response.ok, true)
  const zip = join(temporary, archive)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zip, { flags: 'wx' }))
  assert.equal(hash(await fs.readFile(zip)), expected, '官方 Mac ZIP 与已锁定 npm 发行包的校验和不一致')
  const unpacked = join(temporary, 'official')
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, unpacked], { timeout: 120000 })
  const framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  const executable = 'Electron.app/Contents/MacOS/Electron'
  const versions = JSON.parse(execFileSync(join(unpacked, executable), ['--no-warnings', '-e', 'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node}))'], { env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 }))
  assert.equal(versions.platform, 'darwin'); assert.equal(versions.arch, 'arm64'); assert.equal(versions.electron, version)
  const files = {}
  for (const name of ['LICENSE', 'LICENSES.chromium.html', framework]) {
    const bytes = await fs.readFile(join(unpacked, name))
    const digest = hash(bytes)
    assert.equal(hash(await fs.readFile(join(packageRoot, 'dist', name))), digest, 'npm 安装运行时与独立核验的官方原包不一致')
    files[name] = { bytes: bytes.length, sha256: digest }
  }
  const html = await fs.readFile(join(unpacked, 'LICENSES.chromium.html'), 'utf8')
  const nodes = [...html.matchAll(/<span class="title">Node\.js<\/span>[\s\S]*?<pre>([\s\S]*?)<\/pre>/g)]
  assert.equal(nodes.length, 1)
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  const text = nodes[0][1].replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, value) => value[0] === '#' ? String.fromCodePoint(value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1))) : entities[value.toLowerCase()])
  const report = { source, archive_sha256: expected, npm_integrity: locked.integrity, versions, files, node_notice_sha256: hash(text.replace(/\s+/gu, ' ').trim()), official_archive_verified: true, installed_bytes_match: true }
  await fs.mkdir('release/m2a-diagnostics', { recursive: true })
  await fs.writeFile('release/m2a-diagnostics/runtime-reference.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  assert.equal(dirname(temporary), process.env.RUNNER_TEMP)
  assert.match(temporary.split('/').at(-1), /^privateradar-m2a-runtime-/)
  await fs.rm(temporary, { recursive: true, force: true })
}
