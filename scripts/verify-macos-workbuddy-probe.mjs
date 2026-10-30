import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

// 真实 Mac 上执行系统查询，使用独立空目录；不接触 runner 的 WorkBuddy 或数据库。
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const compiled = await build({ entryPoints: ['src/main/macos-workbuddy-probe/core.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { probeMacWorkBuddy, runProbeCommand } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'))
const plist = await runProbeCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], Buffer.from('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.privateradar.probe-fixture</string></dict></plist>'))
assert.equal(JSON.parse(plist).CFBundleIdentifier, 'cn.privateradar.probe-fixture')
const temporary = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'privateradar-m2a-system-')))
try {
  const session = await probeMacWorkBuddy({ platform: process.platform, home: temporary, systemApplications: join(temporary, 'Applications'), userData: join(temporary, 'PrivateRadar'), appVersion: '0.2.0-alpha.26', isPackaged: false, electronVersion: '44.10.0', nodeVersion: process.versions.node })
  assert.match(session.report.system.macos_version, /^\d+\.\d+/)
  assert.equal(session.report.runtime.env_node_resolves, true)
  assert.equal(session.report.runtime.node_version, 'v24.14.0')
  assert.equal(session.report.workbuddy_roots.some(root => root.exists), false)
  assert.equal(session.report.capability.real_mac_workbuddy_validated, false)
  assert.equal(JSON.stringify(session.report).includes(temporary), false)
  assert.deepEqual(await fs.readdir(temporary), [])
  await fs.mkdir('release/m2a-diagnostics', { recursive: true })
  await fs.writeFile('release/m2a-diagnostics/system-smoke.json', JSON.stringify({ status: 'PASS', platform: process.platform, arch: process.arch, macos: session.report.system.macos_version, node: session.report.runtime.node_version, workbuddy_host_validated: false }, null, 2) + '\n')
} finally {
  assert.match(temporary.split('/').at(-1), /^privateradar-m2a-system-/)
  await fs.rm(temporary, { recursive: true, force: true })
}
