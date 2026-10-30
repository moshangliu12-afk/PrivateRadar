import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const require = createRequire(import.meta.url)
const directory = 'release/stage3a-arm64'
const product = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(product.version, '0.2.0-alpha.26')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(head, process.env.GITHUB_SHA)
const packaging = JSON.parse(readFileSync(join(directory, 'stage3a-package-report.json'), 'utf8'))
assert.equal(packaging.sourceCommit, head)
assert.equal(packaging.CI_PACKAGE, 'PASS')
assert.equal(packaging.APP_ARCH, 'arm64')
assert.equal(packaging.WINDOWS_ONLY_RESOURCES_EXCLUDED_FROM_MAC, 'YES')
const asar = require('@electron/asar')
const appAsar = join(directory, 'mac-arm64/PrivateRadar.app/Contents/Resources/app.asar')
const main = asar.extractFile(appAsar, 'out/main/index.js').toString('utf8')
const preload = asar.extractFile(appAsar, 'out/preload/index.mjs').toString('utf8')
assert.ok(main.includes('macos-workbuddy-probe-v1'))
for (const channel of ['macos-workbuddy-probe:run', 'macos-workbuddy-probe:export']) {
  assert.ok(main.includes(channel)); assert.ok(preload.includes(channel))
}
for (const name of ['targeted', 'full']) {
  const tests = JSON.parse(readFileSync(`release/m2a-diagnostics/${name}.json`, 'utf8'))
  assert.equal(tests.success, true); assert.equal(tests.numFailedTests, 0); assert.ok(tests.numPassedTests > 0)
}
const smoke = JSON.parse(readFileSync('release/m2a-diagnostics/system-smoke.json', 'utf8'))
assert.equal(smoke.status, 'PASS')
const artifacts = [packaging.DMG_NAME, packaging.APP_ZIP_NAME].map(name => {
  assert.ok(name && !name.includes('/') && !name.includes('\\'))
  const file = join(directory, name)
  return { name, bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
})
assert.equal(artifacts[0].sha256, packaging.DMG_SHA256)
assert.equal(artifacts[1].sha256, packaging.APP_ZIP_SHA256)
const report = {
  phase: 'M2A_REAL_MAC_PROBE_CANDIDATE', source_commit: head, baseline: '655cff57b58306b1158a61b1b61834ea43f73871',
  version: product.version, platform: process.platform, arch: process.arch, node: process.version,
  report_schema: 'macos-workbuddy-probe-v1', probe_present_in_app: true, windows_connector_excluded: true,
  signed: false, notarized: false, gatekeeper_real_friend_open: 'PENDING', real_workbuddy_host_validated: false,
  workflow_run: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  artifacts
}
writeFileSync(join(directory, 'm2a-probe-build-report.json'), JSON.stringify(report, null, 2) + '\n')
writeFileSync(join(directory, 'SHA256SUMS.txt'), artifacts.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n')
// 分发包只有一层文件，朋友无需在构建目录中寻找应用或指南。
const delivery = 'release/m2a-candidate'
mkdirSync(delivery, { recursive: true })
for (const name of [...artifacts.map(file => file.name), 'm2a-probe-build-report.json', 'SHA256SUMS.txt']) copyFileSync(join(directory, name), join(delivery, name))
copyFileSync('MACOS_M2A_FRIEND_TEST_GUIDE.md', join(delivery, 'MACOS_M2A_FRIEND_TEST_GUIDE.md'))
console.log(JSON.stringify(report, null, 2))
