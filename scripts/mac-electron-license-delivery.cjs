const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } = require('node:fs')
const { dirname, isAbsolute, join, relative, sep } = require('node:path')

// 摘要来自已核验的官方 44.3.0 darwin-arm64 原包，不使用 Windows 材料。
const expected = Object.freeze({
  electron: '44.3.0', chrome: '152.0.7977.78', node: '24.20.0',
  electronLicense: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d',
  chromiumNotices: 'a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535',
  nodeNotice: '1f88fd8abc0fc59a108512b681cc0e95c8200e13491cc9a90c161541a8b73ce2',
  framework: '8c8ba438c3b55fab5a1f5d0d43a9d149a504936eccc1cadb17b90b534faff74f'
})
const filenames = Object.freeze({
  electronLicense: 'Electron-LICENSE.txt', chromiumNotices: 'Electron-LICENSES.chromium.html'
})
const frameworkRelative = join('Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
const hash = value => createHash('sha256').update(value).digest('hex')

function regularFile(path) {
  assert.ok(lstatSync(path).isFile(), `缺少普通文件：${path}`)
  const bytes = readFileSync(path)
  assert.ok(bytes.length > 0, `文件为空：${path}`)
  return bytes
}

function inside(directory, path) {
  const subpath = relative(realpathSync(directory), realpathSync(path))
  assert.ok(subpath && subpath !== '..' && !subpath.startsWith('..' + sep) && !isAbsolute(subpath), '运行时路径越出来源目录')
  return realpathSync(path)
}

function runtimeDirectory(projectRoot) {
  return join(dirname(require.resolve('electron/package.json', { paths: [projectRoot] })), 'dist')
}

function ensureMacElectronRuntime(projectRoot) {
  assert.equal(process.platform, 'darwin', '运行时准备必须在真实 macOS 上执行')
  assert.equal(process.arch, 'arm64', '运行时准备必须在真实 arm64 上执行')
  const packagePath = require.resolve('electron/package.json', { paths: [projectRoot] })
  const packageRoot = dirname(packagePath)
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'))
  const lockVersion = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8')).packages['node_modules/electron'].version
  assert.equal(lockVersion, expected.electron, '锁文件 Electron 版本不匹配')
  assert.equal(installed.version, expected.electron, '已安装 Electron 包版本不匹配')
  const directory = runtimeDirectory(projectRoot)
  if (!existsSync(directory)) {
    assert.equal(installed.bin['install-electron'], 'install.js', '官方 Electron 安装入口不匹配')
    const installer = join(packageRoot, 'install.js')
    regularFile(installer)
    const checksums = JSON.parse(readFileSync(join(packageRoot, 'checksums.json'), 'utf8'))
    assert.equal(checksums[`electron-v${expected.electron}-darwin-arm64.zip`],
      '49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035', '官方 Mac 发行包校验和不匹配')
    // 只传递基本系统变量，固定官方目标；不继承镜像、缓存覆盖、跳过下载、调试或签名变量。
    const env = {}
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
      if (process.env[name] !== undefined) env[name] = process.env[name]
    }
    Object.assign(env, { ELECTRON_INSTALL_PLATFORM: 'darwin', ELECTRON_INSTALL_ARCH: 'arm64' })
    console.log('准备固定版本的官方 macOS arm64 Electron 运行时。')
    execFileSync(process.execPath, [installer], { cwd: projectRoot, env, timeout: 600000, maxBuffer: 1048576 })
    assert.ok(existsSync(directory), '官方运行时安装完成后仍缺少 dist')
  }
  // 已有目录也必须通过原有门禁，不以重新下载掩盖版本或来源不符。
  return inspectMacElectronRuntime(projectRoot)
}

function verifyRuntimeVersions(lockVersion, packageVersion, actual) {
  assert.equal(lockVersion, expected.electron, '锁文件 Electron 版本不匹配')
  assert.equal(packageVersion, expected.electron, '已安装 Electron 包版本不匹配')
  assert.equal(actual.platform, 'darwin', 'Electron 来源不是 macOS')
  assert.equal(actual.arch, 'arm64', 'Electron 来源不是 arm64')
  for (const name of ['electron', 'chrome', 'node']) assert.equal(actual[name], expected[name], `实际 ${name} 版本不匹配`)
}

// 只提取固定格式中的 Node 条目并核对完整正文，不执行或改写 HTML。
function verifyNodeNotice(bytes) {
  const html = bytes.toString('utf8')
  const nodes = [...html.matchAll(/<span class="title">Node\.js<\/span>[\s\S]*?<pre>([\s\S]*?)<\/pre>/g)]
  assert.equal(nodes.length, 1, 'Node 完整通知条目缺失或重复')
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  const text = nodes[0][1].replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()]
    return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  })
  assert.equal(hash(text.replace(/\s+/gu, ' ').trim()), expected.nodeNotice, 'Node 24.20.0 完整通知不匹配')
  return 'YES'
}

function inspectMacElectronRuntime(projectRoot) {
  assert.equal(process.platform, 'darwin', '运行时检查必须在真实 macOS 上执行')
  assert.equal(process.arch, 'arm64', '运行时检查必须在真实 arm64 上执行')
  const packagePath = require.resolve('electron/package.json', { paths: [projectRoot] })
  const packageRoot = dirname(packagePath)
  const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
  const lockVersion = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8')).packages['node_modules/electron'].version
  assert.equal(lockVersion, expected.electron, '锁文件 Electron 版本不匹配')
  assert.equal(packageVersion, expected.electron, '已安装 Electron 包版本不匹配')
  const directory = realpathSync(runtimeDirectory(projectRoot))
  assert.equal(readFileSync(join(directory, 'version'), 'utf8').trim(), expected.electron, '运行时目录版本不匹配')
  assert.equal(existsSync(join(directory, `electron-v${expected.electron}-darwin-arm64.zip`)), false, '来源目录含可能改变 builder 来源选择的 ZIP')
  const executableRelative = readFileSync(join(packageRoot, 'path.txt'), 'utf8').trim()
  assert.equal(executableRelative, 'Electron.app/Contents/MacOS/Electron', 'Electron 可执行文件路径不是 Mac 发行结构')
  const executable = inside(directory, join(directory, executableRelative))
  const framework = inside(directory, join(directory, 'Electron.app', frameworkRelative))
  assert.equal(hash(regularFile(framework)), expected.framework, 'Electron Framework 与官方 darwin-arm64 来源不匹配')
  // 子进程只接收运行方式变量，不继承签名凭据、NODE_OPTIONS 或其他注入参数。
  const actual = JSON.parse(execFileSync(executable, ['--no-warnings', '-e',
    'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node}))'
  ], { cwd: projectRoot, env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 }))
  verifyRuntimeVersions(lockVersion, packageVersion, actual)
  const materials = {}
  for (const [key, sourceName] of Object.entries({ electronLicense: 'LICENSE', chromiumNotices: 'LICENSES.chromium.html' })) {
    const sourcePath = join(directory, sourceName)
    inside(directory, sourcePath)
    const bytes = regularFile(sourcePath)
    const sha256 = hash(bytes)
    assert.equal(sha256, expected[key], `官方 Mac ${sourceName} 原字节不匹配`)
    materials[key] = { sourcePath, filename: filenames[key], sha256 }
  }
  return { sourceDirectory: directory, executable, framework, frameworkSha256: expected.framework,
    versions: actual, materials, nodeNoticeIncluded: verifyNodeNotice(regularFile(materials.chromiumNotices.sourcePath)) }
}

function licenseDirectory(app) {
  const resources = join(app, 'Contents', 'Resources')
  for (const path of [app, join(app, 'Contents'), resources]) {
    assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), '应用许可目标路径不是普通目录')
  }
  const directory = join(resources, 'licenses')
  if (existsSync(directory)) assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), '许可目录不能是符号链接')
  return directory
}

function copyLicenseMaterials(app, materials) {
  const directory = licenseDirectory(app)
  // 先核验全部来源，再创建目标，缺文件或摘要不符时不生成部分交付。
  for (const [key, material] of Object.entries(materials)) {
    assert.equal(material.filename, filenames[key], '许可目标文件名不匹配')
    assert.equal(hash(regularFile(material.sourcePath)), material.sha256, '复制前许可来源摘要改变')
  }
  assert.deepEqual(Object.keys(materials).sort(), Object.keys(filenames).sort(), '许可材料不完整')
  mkdirSync(directory, { recursive: true })
  for (const material of Object.values(materials)) {
    const target = join(directory, material.filename)
    copyFileSync(material.sourcePath, target, constants.COPYFILE_EXCL)
    assert.equal(hash(regularFile(target)), material.sha256, '复制后许可摘要不匹配')
  }
}

function verifyAppElectronLicenses(app, runtime) {
  const directory = licenseDirectory(app)
  assert.deepEqual(Object.keys(runtime.materials).sort(), Object.keys(filenames).sort(), '最终应用许可材料不完整')
  const files = {}
  for (const [key, material] of Object.entries(runtime.materials)) {
    assert.equal(material.filename, filenames[key], '最终应用许可文件名不匹配')
    const target = join(directory, material.filename)
    const sha256 = hash(regularFile(target))
    assert.equal(sha256, material.sha256, '最终应用许可摘要不匹配')
    assert.equal(hash(regularFile(material.sourcePath)), sha256, '最终许可与实际运行时来源不一致')
    files[key] = { sourcePath: material.sourcePath, targetPath: target, sha256, byteIdentical: 'YES' }
  }
  return { ...runtime.versions, sourceDirectory: runtime.sourceDirectory, files,
    nodeNoticeIncluded: verifyNodeNotice(regularFile(join(directory, filenames.chromiumNotices))), injectedBeforeSigning: 'YES' }
}

async function afterPack(context) {
  assert.equal(context.electronPlatformName, 'darwin', '此许可钩子仅适用于 Mac')
  assert.equal(context.arch, require('builder-util').Arch.arm64, '此许可钩子仅适用于 arm64')
  const runtime = inspectMacElectronRuntime(context.packager.projectDir)
  assert.equal(realpathSync(context.packager.config.electronDist), runtime.sourceDirectory, 'builder 与许可来源目录不一致')
  assert.equal(context.packager.config.electronVersion, expected.electron, 'builder Electron 版本不匹配')
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  assert.equal(hash(regularFile(join(app, frameworkRelative))), runtime.frameworkSha256, '实际 App Framework 与许可来源不一致')
  copyLicenseMaterials(app, runtime.materials)
  verifyAppElectronLicenses(app, runtime)
}

module.exports = afterPack
Object.assign(module.exports, { expected, filenames, runtimeDirectory, ensureMacElectronRuntime, verifyRuntimeVersions,
  verifyNodeNotice, inspectMacElectronRuntime, copyLicenseMaterials, verifyAppElectronLicenses })
