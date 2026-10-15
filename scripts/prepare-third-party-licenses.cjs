const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { basename, join, resolve } = require('node:path')
const projectLicenseDelivery = require('./project-license-delivery.cjs')

const root = resolve(__dirname, '..')
const requiredComponents = ['@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod', 'content-type',
  '@cfworker/json-schema', 'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'json-schema-typed']
const installedComponents = requiredComponents.slice(0, 3)
const electronFiles = ['Electron-LICENSE.txt', 'Electron-LICENSES.chromium.html']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'

function ordinaryDirectory(path) {
  const stat = lstatSync(path)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `许可路径不是普通目录：${path}`)
}

function bytes(path) {
  const stat = lstatSync(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `许可来源不是普通文件：${path}`)
  const value = readFileSync(path)
  assert.ok(value.length > 0, `许可文件为空：${path}`)
  return value
}

function readme(inventory, scope) {
  const components = inventory.components.filter(component => scope === 'app' || component.connector)
  return ['第三方许可与来源索引', '',
    scope === 'app' ? '本目录交付 B0-2 已核验的 MCP、内嵌依赖和 zod 原文。' : '本目录随独立 WorkBuddy Connector 一起分发，原文由项目 licenses/runtime 确定性生成。',
    '版本、来源身份、版权与原文摘要见 inventory.json；完整原文均可离线阅读。',
    'MCP 适用 Apache-2.0 / MIT 按贡献授权的过渡声明；普通文档 CC-BY-4.0 的说明不证明对应文档随包。',
    'json-schema-typed 仅为 App 随附的类型及源码映射资料，不计作 Connector 运行库。',
    '本索引只覆盖 B0-2，不表示项目自身许可、FFmpeg 或全部原生组件发行工作已经完成。', '',
    ...components.map(component => `${component.name} ${component.version} | ${component.classification} | ${component.licenseFile} | ${component.distribution}`), ''].join('\n')
}

function validateInventory(projectRoot = root) {
  const directory = join(projectRoot, 'licenses', 'runtime')
  ordinaryDirectory(directory)
  const inventoryBytes = bytes(join(directory, 'inventory.json'))
  const inventory = JSON.parse(inventoryBytes)
  assert.equal(inventory.schemaVersion, 1, '许可清单格式不匹配')
  assert.equal(inventory.scope, 'app', '许可清单范围不匹配')
  assert.deepEqual(inventory.components.map(component => component.name).sort(), [...requiredComponents].sort(), '许可组件清单不完整或重复')
  assert.deepEqual(inventory.packages.map(component => component.name).sort(), [...installedComponents].sort(), '固定包身份不完整')
  const lock = JSON.parse(bytes(join(projectRoot, 'package-lock.json')))
  const files = { 'inventory.json': inventoryBytes }
  for (const component of inventory.components) {
    assert.ok(component.version && component.classification && component.distribution && component.copyright.length, '组件版本、许可分类或版权缺失')
    assert.equal(typeof component.connector, 'boolean', 'Connector 分发范围缺失')
    assert.equal(basename(component.licenseFile), component.licenseFile, '许可文件名越界')
    assert.match(component.licenseFile, /^[a-zA-Z0-9][a-zA-Z0-9.-]*-LICENSE\.txt$/)
    assert.ok(!electronFiles.includes(component.licenseFile), '不得覆盖 Electron 原文')
    assert.match(component.source.url, /^https:\/\/(registry\.npmjs\.org|github\.com)\//)
    const value = bytes(join(directory, component.licenseFile))
    assert.equal(sha256(value), component.sha256, `${component.name} 许可原文摘要不匹配`)
    for (const attribution of component.copyright) assert.ok(value.toString('utf8').includes(attribution), `${component.name} 版权丢失`)
    files[component.licenseFile] = value
  }
  for (const identity of inventory.packages) {
    const installed = JSON.parse(bytes(join(projectRoot, 'node_modules', identity.name, 'package.json')))
    const locked = lock.packages['node_modules/' + identity.name]
    assert.equal(installed.name, identity.name, '已安装包身份不匹配')
    assert.equal(installed.version, identity.version, `${identity.name} 已安装版本不匹配`)
    assert.equal(locked.version, identity.version, `${identity.name} 锁定版本不匹配`)
    assert.equal(locked.integrity, identity.integrity, `${identity.name} 锁定来源不匹配`)
    assert.equal(locked.resolved, identity.resolved, `${identity.name} 发布包地址不匹配`)
    const component = inventory.components.find(item => item.name === identity.name)
    assert.equal(component.version, identity.version, '组件与安装包清单版本不一致')
    assert.equal(sha256(bytes(join(projectRoot, 'node_modules', identity.name, 'LICENSE'))), component.sha256, '已安装包许可与 canonical 原文不一致')
  }
  assert.equal(inventory.distributionFiles.length, 20, 'SDK 固定分发文件清单不完整')
  const pinned = new Set(inventory.distributionFiles.map(file => file.path))
  assert.equal(pinned.size, 20, 'SDK 固定分发文件重复')
  for (const file of inventory.distributionFiles) {
    assert.match(file.path, /^node_modules\/@modelcontextprotocol\/server\/dist\/[a-zA-Z0-9_.-]+$/)
    assert.equal(sha256(bytes(join(projectRoot, file.path))), file.sha256, 'SDK 内嵌代码或映射已改变，须更新许可审计')
  }
  for (const component of inventory.components.filter(item => item.evidence.kind === 'sdk-embedded')) {
    assert.equal(component.evidence.versionToken, component.name.replace('/', '+') + '@' + component.version, '内嵌组件版本不一致')
    assert.ok(component.evidence.carriers.length, '内嵌组件缺少分发证据')
    for (const carrier of component.evidence.carriers) {
      assert.ok(pinned.has(carrier) && pinned.has(carrier + '.map'), '内嵌组件来源未固定')
      const mapping = JSON.parse(bytes(join(projectRoot, carrier + '.map')))
      const token = '/.pnpm/' + component.evidence.versionToken
      assert.ok(mapping.sources.some(source => source.includes(token + '/') || source.includes(token + '_')), 'SDK 映射中的实际版本不匹配')
    }
  }
  // FFmpeg 通知仅随 App 分发；不计入 B0-2 组件或独立 Connector 清单。
  const ffmpegNotice = bytes(join(directory, 'FFmpeg-LGPL-NOTICE.txt'))
  assert.equal(sha256(Buffer.from(ffmpegNotice.toString('utf8').replaceAll('\r\n', '\n'))),
    '190bdb8b27e88722cd9a7e27793c52259c9e99a2cba7be276d4985aff30ba855', 'FFmpeg 通知正文身份不匹配')
  files['FFmpeg-LGPL-NOTICE.txt'] = ffmpegNotice
  files['README.txt'] = Buffer.from(readme(inventory, 'app'))
  verifyDirectory(directory, files)
  return { inventory, files }
}

function connectorFiles(validated) {
  const components = validated.inventory.components.filter(component => component.connector)
  const inventory = { schemaVersion: 1, scope: 'connector', auditDate: validated.inventory.auditDate,
    description: '由 canonical B0-2 清单生成的实际 Connector 内嵌运行代码许可。', components }
  const files = { 'inventory.json': Buffer.from(json(inventory)), 'README.txt': Buffer.from(readme(validated.inventory, 'connector')) }
  for (const component of components) files[component.licenseFile] = validated.files[component.licenseFile]
  return files
}

function verifyDirectory(directory, files, allowedExtra = []) {
  ordinaryDirectory(directory)
  const names = readdirSync(directory)
  assert.deepEqual(names.filter(name => !allowedExtra.includes(name)).sort(), Object.keys(files).sort(), '许可目录文件清单不完整或含未知文件')
  for (const [name, expected] of Object.entries(files)) {
    assert.equal(sha256(bytes(join(directory, name))), sha256(expected), `许可目标内容不匹配：${name}`)
  }
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)]))
}

function verifyConnectorInputs(projectRoot, inventory) {
  const directory = join(projectRoot, 'integrations', 'workbuddy', 'connector', 'dist')
  const metadata = JSON.parse(bytes(join(directory, 'license-inputs.json')))
  const output = metadata.outputs['integrations/workbuddy/connector/dist/server.mjs']
  assert.ok(output && output.entryPoint === 'src/main/integrations/workbuddy/server.ts', 'Connector 构建来源缺失')
  assert.equal(bytes(join(directory, 'server.mjs')).length, output.bytes, 'Connector 构建元数据与实际文件不匹配')
  const included = new Set(Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([name]) => name.replaceAll('\\', '/')))
  for (const name of included) {
    const dependency = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(name)?.[1]
    if (dependency) assert.ok(installedComponents.includes(dependency), 'Connector 增加了未审核的第三方输入')
  }
  for (const component of inventory.components) {
    const present = component.evidence.kind === 'installed-package'
      ? [...included].some(name => name.startsWith('node_modules/' + component.name + '/'))
      : component.evidence.carriers.some(path => included.has(path))
    assert.equal(present, component.connector, `${component.name} Connector 实际分发范围与许可清单不一致`)
  }
}

function verifyConnector(projectRoot, validated = validateInventory(projectRoot), checkInputs = true) {
  const directory = join(projectRoot, 'integrations', 'workbuddy', 'connector', 'licenses')
  const result = verifyDirectory(directory, { ...connectorFiles(validated), ...projectLicenseDelivery.files(projectRoot) })
  delete result[projectLicenseDelivery.fileName]
  if (checkInputs) verifyConnectorInputs(projectRoot, validated.inventory)
  return result
}

function syncConnector(projectRoot = root) {
  const projectFiles = projectLicenseDelivery.files(projectRoot)
  const validated = validateInventory(projectRoot)
  const directory = join(projectRoot, 'integrations', 'workbuddy', 'connector', 'licenses')
  const files = { ...connectorFiles(validated), ...projectFiles }
  if (existsSync(directory)) {
    ordinaryDirectory(directory)
    // 写入前检查全部生成目标，避免通过链接改写 canonical 或产品文件。
    for (const name of readdirSync(directory)) {
      assert.ok(Object.hasOwn(files, name), 'Connector 许可生成目录包含未知文件')
      const stat = lstatSync(join(directory, name))
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Connector 许可生成目标不能是链接或非普通文件')
    }
  }
  mkdirSync(directory, { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value)
  verifyConnector(projectRoot, validated, false)
}

function verifyAppLicenses(resources, projectRoot = root, includeConnector = false) {
  const projectFiles = projectLicenseDelivery.files(projectRoot)
  const validated = validateInventory(projectRoot)
  const directory = join(resources, 'licenses')
  const files = verifyDirectory(directory, { ...validated.files, ...projectFiles }, includeConnector ? [] : electronFiles)
  delete files[projectLicenseDelivery.fileName]
  const projectLicense = projectLicenseDelivery.verifyTarget(directory, projectRoot)
  const connectorDirectory = join(resources, 'workbuddy-connector', 'licenses')
  const connector = includeConnector
    ? verifyDirectory(connectorDirectory, { ...connectorFiles(validated), ...projectFiles })
    : null
  if (connector) delete connector[projectLicenseDelivery.fileName]
  const connectorProjectLicense = includeConnector ? projectLicenseDelivery.verifyTarget(connectorDirectory, projectRoot) : null
  if (!includeConnector) assert.equal(existsSync(join(resources, 'workbuddy-connector')), false, 'Mac 不得包含 Windows Connector')
  return { componentCount: validated.inventory.components.length, files, connector, projectLicense, connectorProjectLicense }
}

function beforePack(context) {
  const projectRoot = context.packager.projectDir
  projectLicenseDelivery.validateRoot(projectRoot)
  const validated = validateInventory(projectRoot)
  verifyConnector(projectRoot, validated)
}

async function afterPack(context) {
  assert.ok(['darwin', 'win32'].includes(context.electronPlatformName), '本许可钩子只覆盖当前 Mac / Windows 分发')
  const mac = context.electronPlatformName === 'darwin'
  if (mac) await require('./mac-electron-license-delivery.cjs')(context)
  const resources = mac ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  return verifyAppLicenses(resources, context.packager.projectDir, !mac)
}

module.exports = { readme, validateInventory, connectorFiles, verifyDirectory, verifyConnectorInputs, verifyConnector,
  syncConnector, verifyAppLicenses, beforePack, afterPack }

if (require.main === module) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), '未知许可准备参数')
  if (process.argv[2] === '--check') verifyConnector(root)
  else syncConnector(root)
}
