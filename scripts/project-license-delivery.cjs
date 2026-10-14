const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const fileName = 'PrivateRadar-LICENSE.txt'
// 固定当前根 LICENSE 的完整正文身份，仅允许 Git 检出的 LF／CRLF 差异。
const normalizedSha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
const sha256 = value => createHash('sha256').update(value).digest('hex')

function bytes(path) {
  const stat = lstatSync(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), '项目许可证必须为普通文件')
  const value = readFileSync(path)
  assert.ok(value.length > 0, '项目许可证不能为空')
  return value
}

function validateRoot(projectRoot) {
  const sourcePath = join(projectRoot, 'LICENSE')
  const value = bytes(sourcePath)
  const text = value.toString('utf8')
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/, '项目许可证不是 Apache-2.0')
  assert.equal(sha256(Buffer.from(text.replaceAll('\r\n', '\n'))), normalizedSha256, '根 LICENSE 正文身份改变，须先审核')
  return { sourcePath, bytes: value, sha256: sha256(value) }
}

function files(projectRoot) {
  return { [fileName]: validateRoot(projectRoot).bytes }
}

function extraResource() {
  return { from: 'LICENSE', to: 'licenses/' + fileName }
}

function verifyTarget(directory, projectRoot) {
  const source = validateRoot(projectRoot)
  const stat = lstatSync(directory)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), '项目许可证目标必须为普通目录')
  const targetPath = join(directory, fileName)
  const target = bytes(targetPath)
  // 复制不转换换行：每个平台的目标必须与本次根 LICENSE 逐字节一致。
  assert.deepEqual(target, source.bytes, '项目许可证目标与根 LICENSE 不一致')
  assert.equal(sha256(target), source.sha256, '项目许可证目标摘要不匹配')
  return { canonicalSource: 'LICENSE', sourcePath: source.sourcePath, targetPath,
    sha256: source.sha256, normalizedSha256, byteIdentical: 'YES', textIntegrity: 'PASS' }
}

module.exports = { fileName, normalizedSha256, validateRoot, files, extraResource, verifyTarget }
