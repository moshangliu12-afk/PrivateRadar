import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const delivery = require('../scripts/mac-electron-license-delivery.cjs')
const reference = require('../scripts/macos-electron-runtime-reference.json')
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

it('Mac 打包固定版本与当前锁文件及经独立原包核验的来源一致', () => {
  const installed = require('electron/package.json').version
  expect(delivery.expected.electron).toBe(lock.packages['node_modules/electron'].version)
  expect(delivery.expected.electron).toBe(installed)
  expect(reference.npm_integrity).toBe(lock.packages['node_modules/electron'].integrity)
  expect(reference.archive_sha256).toBe(require('electron/checksums.json')[`electron-v${installed}-darwin-arm64.zip`])
  expect(reference.official_archive_verified).toBe(true)
  expect(reference.installed_bytes_match).toBe(true)
  expect(delivery.expected.framework).toBe(reference.files['Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'].sha256)
  expect(delivery.expected.chromiumNotices).toBe(reference.files['LICENSES.chromium.html'].sha256)
  expect(delivery.expected.electronLicense).toBe(reference.files.LICENSE.sha256)
  expect(delivery.expected.nodeNotice).toBe(reference.node_notice_sha256)
  expect(() => delivery.verifyRuntimeVersions(installed, installed, reference.versions)).not.toThrow()
})

it.each(['platform', 'arch', 'electron', 'chrome', 'node'])('实际 %s 身份错误仍拒绝，不放宽原打包门禁', field => {
  expect(() => delivery.verifyRuntimeVersions(delivery.expected.electron, delivery.expected.electron, { ...reference.versions, [field]: '错误身份' })).toThrow()
})
