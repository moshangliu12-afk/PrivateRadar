import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { macConfiguration, unsignedEnvironment, ensureMacElectronRuntime, verifyAppElectronLicenses, verifyAppLicenses } from './package-macos-arm64.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRelative = 'release/stage3c-arm64'
const keyPrefix = 'privateradar-stage3c-'
const keyName = 'AuthKey.p8'
export const credentialNames = Object.freeze([
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'
])

// 仅映射当前 alpha 序号，不更改产品版本，也不猜测未来发行阶段。
export function bundleVersions(version) {
  const match = /^(\d+\.\d+\.\d+)-alpha\.([1-9]\d{0,3})$/.exec(version)
  assert.ok(match, 'UNSUPPORTED_MAC_BUNDLE_VERSION')
  return { bundleShortVersion: match[1], bundleVersion: match[2] }
}

export function signedConfiguration(product) {
  const configuration = macConfiguration(product)
  const { identity, ...mac } = configuration.mac
  return {
    ...configuration,
    directories: { ...configuration.directories, output: outputRelative },
    mac: {
      ...mac,
      type: 'distribution',
      forceCodeSigning: true,
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      preAutoEntitlements: false,
      notarize: true,
      ...bundleVersions(product.version),
      artifactName: 'PrivateRadar-${version}-macOS-arm64-signed-notarized.${ext}'
    },
    dmg: { sign: true, writeUpdateInfo: false }
  }
}

// 只返回凭据名称及存在性；不返回值、长度或片段。
export function credentialPresence(source) {
  return Object.fromEntries(credentialNames.map(name => [name, Boolean(source[name]?.trim())]))
}

// 丢弃其他认证方式及调试变量，避免环境变量改变锁定的认证分支。
export function signingEnvironment(source, keyPath) {
  const environment = unsignedEnvironment(source)
  for (const name of ['DEBUG', 'DEBUG_COLORS', 'ELECTRON_BUILDER_DEBUG', 'NODE_DEBUG']) delete environment[name]
  environment.CSC_IDENTITY_AUTO_DISCOVERY = 'true'
  environment.CSC_LINK = source.CSC_LINK
  environment.CSC_KEY_PASSWORD = source.CSC_KEY_PASSWORD
  environment.APPLE_API_KEY = keyPath
  environment.APPLE_API_KEY_ID = source.APPLE_API_KEY_ID
  environment.APPLE_API_ISSUER = source.APPLE_API_ISSUER
  return environment
}

// 捕获子进程输出供检查，不打印认证参数、工具原始日志或证书材料。
async function run(command, args, environment, failureCode) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data.toString() })
    child.on('error', () => reject(new Error(failureCode)))
    child.on('close', code => {
      if (code !== 0) reject(new Error(failureCode))
      else resolveResult(output)
    })
  })
}

// 身份详情只保留允许公开的类型、团队、信任链类型和运行时标志。
export function signingSummary(details, expectedIdentifier, expectedTeam) {
  const identifier = /^Identifier=(.+)$/m.exec(details)?.[1]
  const teamIdentifier = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1]
  const authority = [...details.matchAll(/^Authority=(.+)$/gm)].map(match => match[1])
  assert.equal(identifier, expectedIdentifier, 'SIGNED_IDENTIFIER_MISMATCH')
  assert.ok(teamIdentifier, 'SIGNED_TEAM_IDENTIFIER_MISSING')
  if (expectedTeam) assert.equal(teamIdentifier, expectedTeam, 'SIGNED_TEAM_MISMATCH')
  assert.ok(authority[0]?.startsWith('Developer ID Application:'), 'WRONG_SIGNING_IDENTITY_TYPE')
  assert.ok(authority.includes('Developer ID Certification Authority'), 'WRONG_SIGNING_AUTHORITY')
  assert.ok(authority.includes('Apple Root CA'), 'WRONG_SIGNING_ROOT_AUTHORITY')
  assert.match(details, /^CodeDirectory\b.*\bflags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/mi, 'HARDENED_RUNTIME_MISSING')
  return {
    identityType: 'Developer ID Application', teamIdentifier,
    authority: ['Developer ID Application', 'Developer ID Certification Authority', 'Apple Root CA'],
    hardenedRuntime: true, bundleIdentifier: identifier
  }
}

function cleanupKey(directory) {
  const temporaryRoot = realpathSync(tmpdir())
  assert.equal(dirname(directory), temporaryRoot, 'UNSAFE_KEY_CLEANUP_PATH')
  assert.ok(directory.startsWith(join(temporaryRoot, keyPrefix)), 'UNSAFE_KEY_CLEANUP_PATH')
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'UNSAFE_KEY_CLEANUP_PATH')
  // 只删除本流程自己的单文件，不进行递归删除。
  rmSync(join(directory, keyName), { force: true })
  rmdirSync(directory)
}

async function verifyApplication(app, product, environment) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], environment, 'APP_SIGNATURE_INVALID')
  const details = await run('codesign', ['-dv', '--verbose=4', app], environment, 'APP_SIGNATURE_DETAILS_FAILED')
  const summary = signingSummary(details, product.build.appId)
  const helperRoot = join(app, 'Contents', 'Frameworks')
  for (const name of readdirSync(helperRoot).filter(name => name.endsWith('.app'))) {
    const helper = join(helperRoot, name)
    const helperDetails = await run('codesign', ['-dv', '--verbose=4', helper], environment, 'HELPER_SIGNATURE_DETAILS_FAILED')
    const identifier = /^Identifier=(.+)$/m.exec(helperDetails)?.[1]
    assert.ok(identifier?.startsWith(product.build.appId + '.'), 'HELPER_IDENTIFIER_MISMATCH')
    signingSummary(helperDetails, identifier, summary.teamIdentifier)
  }
  const versions = bundleVersions(product.version)
  const info = join(app, 'Contents', 'Info.plist')
  for (const [key, expected] of Object.entries({ CFBundleShortVersionString: versions.bundleShortVersion, CFBundleVersion: versions.bundleVersion })) {
    const actual = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info], environment, 'BUNDLE_VERSION_READ_FAILED')
    assert.equal(actual.trim(), expected, 'BUNDLE_VERSION_MISMATCH')
  }
  const executable = join(app, 'Contents', 'MacOS', product.productName)
  const arch = await run('lipo', ['-archs', executable], environment, 'APP_ARCH_READ_FAILED')
  assert.equal(arch.trim(), 'arm64', 'APP_ARCH_MISMATCH')
  // 固定版本 builder 原生公证已装订应用；后验门禁防止静默跳过。
  await run('xcrun', ['stapler', 'validate', app], environment, 'APP_STAPLE_INVALID')
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], environment, 'APP_GATEKEEPER_REJECTED')
  return summary
}

async function notarizeDmg(dmg, environment, appSummary) {
  await run('codesign', ['--verify', '--strict', '--verbose=2', dmg], environment, 'DMG_SIGNATURE_INVALID')
  const details = await run('codesign', ['-dv', '--verbose=4', dmg], environment, 'DMG_SIGNATURE_DETAILS_FAILED')
  // DMG 签名无需运行时标志，但必须使用同一 Developer ID 团队。
  assert.match(details, /^Authority=Developer ID Application:/m, 'WRONG_DMG_SIGNING_IDENTITY')
  assert.equal(/^TeamIdentifier=(.+)$/m.exec(details)?.[1], appSummary.teamIdentifier, 'DMG_TEAM_MISMATCH')
  const rawResult = await run('xcrun', [
    'notarytool', 'submit', dmg, '--key', environment.APPLE_API_KEY,
    '--key-id', environment.APPLE_API_KEY_ID, '--issuer', environment.APPLE_API_ISSUER,
    '--wait', '--output-format', 'json'
  ], environment, 'DMG_NOTARIZATION_FAILED')
  const result = JSON.parse(rawResult)
  assert.equal(result.status, 'Accepted', 'DMG_NOTARIZATION_NOT_ACCEPTED')
  assert.match(result.id, /^[0-9a-f-]{36}$/i, 'DMG_NOTARIZATION_ID_INVALID')
  await run('xcrun', ['stapler', 'staple', dmg], environment, 'DMG_STAPLE_FAILED')
  await run('xcrun', ['stapler', 'validate', dmg], environment, 'DMG_STAPLE_INVALID')
  await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], environment, 'DMG_GATEKEEPER_REJECTED')
  return { status: result.status, submissionId: result.id }
}

async function packageSignedMac() {
  // 在 Windows 或错误架构上拒绝执行，尚不读取任何 Apple 凭据。
  assert.equal(process.platform, 'darwin', 'MACOS_REQUIRED')
  assert.equal(process.arch, 'arm64', 'ARM64_REQUIRED')
  assert.equal(require('electron-builder/package.json').version, '26.0.12', 'BUILDER_VERSION_MISMATCH')
  assert.equal(require('@electron/notarize/package.json').version, '2.5.0', 'NOTARIZE_VERSION_MISMATCH')
  const presence = credentialPresence(process.env)
  for (const [name, present] of Object.entries(presence)) console.log(`${name}: ${present ? '存在' : '不存在'}`)
  assert.ok(Object.values(presence).every(Boolean), 'MISSING_SIGNING_CREDENTIALS')
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const configuration = signedConfiguration(product)
  const electronRuntime = ensureMacElectronRuntime(root)
  configuration.electronDist = electronRuntime.sourceDirectory
  const output = join(root, outputRelative)
  const buildEnvironment = unsignedEnvironment(process.env)
  const sourceCommit = (await run('git', ['rev-parse', 'HEAD'], buildEnvironment, 'SOURCE_COMMIT_READ_FAILED')).trim()
  if (process.env.GITHUB_SHA) assert.equal(sourceCommit, process.env.GITHUB_SHA, 'SOURCE_COMMIT_MISMATCH')
  assert.equal((await run('git', ['status', '--porcelain'], buildEnvironment, 'SOURCE_STATUS_READ_FAILED')).trim(), '', 'SOURCE_WORKTREE_DIRTY')
  // 不覆盖旧产物，避免误把前次产物当成本次候选。
  mkdirSync(output, { recursive: true })
  assert.equal(readdirSync(output).length, 0, 'SIGNED_OUTPUT_NOT_EMPTY')
  console.log('开始构建独立签名候选。')
  await run('npm', ['run', 'build'], buildEnvironment, 'PRODUCT_BUILD_FAILED')
  const configPath = join(output, 'builder-mac-signed-config.json')
  writeFileSync(configPath, JSON.stringify(configuration, null, 2) + '\n')
  const temporaryDirectory = mkdtempSync(join(realpathSync(tmpdir()), keyPrefix))
  chmodSync(temporaryDirectory, 0o700)
  try {
    const keyPath = join(temporaryDirectory, keyName)
    writeFileSync(keyPath, process.env.APPLE_API_KEY_P8, { mode: 0o600, flag: 'wx' })
    chmodSync(keyPath, 0o600)
    const environment = signingEnvironment(process.env, keyPath)
    await run(process.execPath, [
      require.resolve('electron-builder/cli.js'), '--config', configPath,
      '--mac', '--arm64', '--publish', 'never'
    ], environment, 'SIGNED_APPLICATION_BUILD_FAILED')
    const app = join(output, 'mac-arm64', `${product.productName}.app`)
    // 签名后这里只读核验，许可注入已在共享 afterPack 阶段完成。
    const electronLicenses = verifyAppElectronLicenses(app, electronRuntime)
    const thirdPartyLicenses = verifyAppLicenses(join(app, 'Contents', 'Resources'), root)
    const appSummary = await verifyApplication(app, product, buildEnvironment)
    const dmgName = `PrivateRadar-${product.version}-macOS-arm64-signed-notarized.dmg`
    const dmg = join(output, dmgName)
    const dmgNotarization = await notarizeDmg(dmg, environment, appSummary)
    const report = {
      stage: 'MACOS_STAGE3C_SIGNED_NOTARIZED_CANDIDATE', sourceCommit,
      productVersion: product.version, platform: process.platform, arch: process.arch,
      electronLicenses, thirdPartyLicenses,
      ...bundleVersions(product.version), signing: appSummary,
      appStaple: 'PASS', appGatekeeper: 'PASS', dmgNotarization,
      dmgStaple: 'PASS', dmgGatekeeper: 'PASS', artifact: dmgName,
      sha256: createHash('sha256').update(readFileSync(dmg)).digest('hex')
    }
    writeFileSync(join(output, 'stage3c-package-report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log('签名、公证、装订及 Gatekeeper 检查通过。')
  } finally {
    cleanupKey(temporaryDirectory)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--cleanup') {
      assert.equal(process.platform, 'darwin', 'MACOS_REQUIRED')
      const temporaryRoot = realpathSync(tmpdir())
      for (const name of readdirSync(temporaryRoot).filter(name => name.startsWith(keyPrefix))) cleanupKey(join(temporaryRoot, name))
    } else {
      assert.equal(process.argv.length, 2, 'UNSUPPORTED_SIGNING_ARGUMENTS')
      await packageSignedMac()
    }
  } catch (error) {
    // 只显示固定错误码，不传播第三方异常中的凭据或原始输出。
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MACOS_SIGNED_CANDIDATE_FAILED')
    process.exitCode = 1
  }
}
