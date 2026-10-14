import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronLicenseDelivery from './mac-electron-license-delivery.cjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRelative = 'release/stage3a-arm64'
const output = join(root, outputRelative)
export const { ensureMacElectronRuntime, inspectMacElectronRuntime, verifyAppElectronLicenses } = electronLicenseDelivery

// 只为 Mac 命令创建独立配置，保留 Windows 的共享资源和命名。
export function macConfiguration(product) {
  const { win, nsis, extraResources, extraFiles, ...shared } = structuredClone(product.build)
  return {
    ...shared,
    extends: null,
    directories: { ...shared.directories, output: outputRelative },
    extraResources: [],
    extraFiles: [],
    electronVersion: electronLicenseDelivery.expected.electron,
    electronDist: electronLicenseDelivery.runtimeDirectory(root),
    afterPack: join(root, 'scripts', 'mac-electron-license-delivery.cjs'),
    dmg: { sign: false }
  }
}

// 先过滤变量名，再取其值；不读取 Apple 或签名凭据。
export function unsignedEnvironment(source) {
  const result = {}
  for (const name of Object.keys(source)) {
    if (/^(APPLE_|CSC_)/.test(name) || ['GH_TOKEN', 'GITHUB_TOKEN', 'BT_TOKEN'].includes(name)) continue
    result[name] = source[name]
  }
  result.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return result
}

async function run(command, args, env, allowedFailure = false) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', data => { text += data.toString(); destination.write(data) })
    }
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0 && !allowedFailure) reject(new Error(`命令失败：${command}，退出码 ${code}`))
      else resolveResult({ code, text })
    })
  })
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function windowsPayloadFiles(directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...windowsPayloadFiles(path))
    else if (/\.(exe|ps1|cmd|bat)$/i.test(entry.name)) result.push(path)
  }
  return result
}

async function packageMac() {
  // Windows 上先拒绝，再创建目录或执行任何打包命令。
  assert.equal(process.platform, 'darwin', '此命令必须在真实 macOS 上运行')
  assert.equal(process.arch, 'arm64', 'Stage3A 仅支持 Apple Silicon arm64')
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const config = macConfiguration(product)
  assert.deepEqual(config.mac.target, [
    { target: 'dmg', arch: ['arm64'] }, { target: 'dir', arch: ['arm64'] }
  ])
  assert.equal(config.mac.identity, null)
  assert.equal(config.mac.forceCodeSigning, false)
  assert.equal(config.mac.notarize, false)
  assert.equal(config.asar, true)
  assert.equal(config.asarUnpack, undefined)
  assert.equal(config.afterSign, undefined)
  assert.equal(config.mac.sign, undefined)
  assert.equal(config.publish, undefined)
  assert.equal(require('electron-builder/package.json').version, '26.0.12')
  const env = unsignedEnvironment(process.env)
  const electronRuntime = ensureMacElectronRuntime(root)
  config.electronDist = electronRuntime.sourceDirectory
  mkdirSync(output, { recursive: true })
  const reportPath = join(output, 'stage3a-package-report.json')
  const report = {
    stage: 'MACOS_STAGE3A_UNSIGNED_PACKAGING', developmentOnly: true,
    platform: process.platform, arch: process.arch, nodeVersion: process.version,
    MAC_SIGNING_ATTEMPTED: 'NO', MAC_NOTARIZATION_ATTEMPTED: 'NO',
    MAC_ICON_STAGE3A: 'DEFAULT', CI_PACKAGE: 'FAIL',
    APP_ARTIFACT: 'FAIL', DMG_ARTIFACT: 'FAIL', DMG_INSPECTION: 'NOT_RUN'
  }
  try {
    report.sourceCommit = (await run('git', ['rev-parse', 'HEAD'], env)).text.trim()
    if (process.env.GITHUB_SHA) assert.equal(report.sourceCommit, process.env.GITHUB_SHA)
    await run('npm', ['run', 'build'], env)
    const configPath = join(output, 'builder-mac-config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    const builder = await run(process.execPath, [
      require.resolve('electron-builder/cli.js'), '--config', configPath,
      '--mac', '--arm64', '--publish', 'never'
    ], env, true)
    writeFileSync(join(output, 'builder.log'), builder.text)
    assert.equal(builder.code, 0, 'electron-builder 打包失败，保留真实日志')
    assert.match(builder.text, /skipped macOS code signing/)
    assert.match(builder.text, /identity explicitly is set to null/)
    report.signingSkipVerified = true

    const appName = 'PrivateRadar.app'
    const app = join(output, 'mac-arm64', appName)
    const contents = join(app, 'Contents')
    const plist = join(contents, 'Info.plist')
    const resources = join(contents, 'Resources')
    assert.ok(existsSync(plist), '缺少应用 Info.plist')
    assert.ok(existsSync(resources), '缺少应用 Resources')
    const executableName = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], env)).text.trim()
    assert.equal(executableName, 'PrivateRadar')
    const identifier = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], env)).text.trim()
    assert.equal(identifier, product.build.appId)
    const executable = join(contents, 'MacOS', executableName)
    assert.ok(statSync(executable).isFile(), '缺少应用可执行文件')
    assert.ok((statSync(executable).mode & 0o111) !== 0, '应用可执行位丢失')
    const architecture = (await run('/usr/bin/lipo', ['-archs', executable], env)).text.trim()
    assert.equal(architecture, 'arm64')
    const framework = join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
    assert.equal((await run('/usr/bin/lipo', ['-archs', framework], env)).text.trim(), 'arm64')
    assert.equal(existsSync(join(resources, 'workbuddy-connector')), false, 'Mac 包不得包含 Windows 连接器资源')
    assert.deepEqual(windowsPayloadFiles(resources), [], 'Mac 资源目录含 Windows 负载文件')
    report.electronLicenses = verifyAppElectronLicenses(app, electronRuntime)
    const asarPath = join(resources, 'app.asar')
    const asar = require('@electron/asar')
    const entries = asar.listPackage(asarPath).map(path => path.replaceAll('\\', '/'))
    for (const path of ['/out/main/index.js', '/out/preload/index.mjs', '/out/renderer/index.html']) {
      assert.ok(entries.includes(path), `ASAR 缺少运行入口：${path}`)
    }
    assert.equal(entries.some(path => /\.(exe|ps1|cmd|bat)$/i.test(path)), false, 'ASAR 含 Windows 负载文件')
    Object.assign(report, {
      APP_ARTIFACT: 'PASS', APP_BUNDLE_NAME: appName, APP_EXECUTABLE_PRESENT: 'YES',
      APP_INFO_PLIST_PRESENT: 'YES', APP_RESOURCES_PRESENT: 'YES', APP_ARCH: architecture,
      WINDOWS_ONLY_RESOURCES_EXCLUDED_FROM_MAC: 'YES', asarEntryCount: entries.length,
      bundleIdentifier: identifier
    })

    const dmgName = `PrivateRadar-${product.version}-macOS-arm64-unsigned.dmg`
    const dmg = join(output, dmgName)
    assert.ok(statSync(dmg).isFile() && statSync(dmg).size > 0, '缺少非空 DMG')
    Object.assign(report, { DMG_ARTIFACT: 'PASS', DMG_NAME: dmgName, DMG_NONEMPTY: 'YES' })
    const mountPoint = join(output, 'dmg-inspection')
    mkdirSync(mountPoint, { recursive: true })
    await run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mountPoint], env)
    try {
      const mountedApp = join(mountPoint, appName)
      assert.ok(existsSync(join(mountedApp, 'Contents', 'Info.plist')))
      assert.equal(hash(join(mountedApp, 'Contents', 'MacOS', executableName)), hash(executable))
      assert.equal(hash(join(mountedApp, 'Contents', 'Resources', 'app.asar')), hash(asarPath))
      report.dmgElectronLicenses = verifyAppElectronLicenses(mountedApp, electronRuntime)
      report.DMG_INSPECTION = 'PASS'
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mountPoint], env)
    }

    const zipName = `PrivateRadar-${product.version}-macOS-arm64-unsigned.app.zip`
    const zip = join(output, zipName)
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], env)
    assert.ok(statSync(zip).size > 0, '应用压缩包为空')
    Object.assign(report, {
      CI_PACKAGE: 'PASS', APP_ZIP_NAME: zipName, APP_ZIP_SHA256: hash(zip),
      DMG_SHA256: hash(dmg), APP_ZIP_BYTES: statSync(zip).size, DMG_BYTES: statSync(dmg).size
    })
  } catch (error) {
    report.error = String(error)
    throw error
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageMac()
}
