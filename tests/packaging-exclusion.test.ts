import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import product from '../package.json'

const require = createRequire(import.meta.url)
type EnumerationPackager = {
  config: typeof product.build
  appInfo: { type: string }
  debugLogger: { isEnabled: boolean }
  getWorkspaceRoot: () => Promise<string>
}
const { FileMatcher, getNodeModuleFileMatcher, excludedExts } = require('app-builder-lib/out/fileMatcher') as {
  FileMatcher: new (from: string, to: string, expand: (pattern: string) => string, patterns: string[]) => unknown
  getNodeModuleFileMatcher: (from: string, to: string, expand: (pattern: string) => string, options: object, packager: EnumerationPackager) => { patterns: string[] }
  excludedExts: string
}
const { NodeModuleCopyHelper } = require('app-builder-lib/out/util/NodeModuleCopyHelper') as {
  NodeModuleCopyHelper: new (matcher: unknown, packager: EnumerationPackager) => {
    collectNodeModules: (module: { name: string; dir: string }, excluded: string[], destination: string) => Promise<string[]>
  }
}
const root = process.cwd()
const zodRoot = join(root, 'node_modules', 'zod')
const isZodTest = (path: string): boolean => /^src\/(?:v3\/tests|v4\/.+\/tests)(?:\/|$)/.test(path)

async function enumerateZod(files: string[]): Promise<string[]> {
  // 使用安装包实际调用的依赖收集器；只枚举，不复制、启动或生成产物。
  const destination = join(root, 'out', 'packaging-enumeration')
  const packager: EnumerationPackager = {
    config: { ...product.build, files },
    appInfo: { type: product.type },
    debugLogger: { isEnabled: false },
    getWorkspaceRoot: async () => root
  }
  const dependencyMatcher = getNodeModuleFileMatcher(root, destination, (pattern) => pattern, {}, packager)
  const matcher = new FileMatcher(zodRoot, join(destination, 'node_modules', 'zod'), (pattern) => pattern, dependencyMatcher.patterns)
  const helper = new NodeModuleCopyHelper(matcher, packager)
  const excluded = ['.o', '.obj', ...excludedExts.split(',').map((extension) => `.${extension}`), '.pdb']
  const collected = await helper.collectNodeModules({ name: 'zod', dir: zodRoot }, excluded, join('node_modules', 'zod'))
  return collected.map((path) => relative(zodRoot, path).replaceAll('\\', '/')).sort()
}

describe('Zod 安装包测试目录排除', () => {
  it('真实依赖文件枚举不包含 v3 或 v4 的测试目录', async () => {
    const packaged = await enumerateZod(product.build.files)
    expect(packaged.length).toBeGreaterThan(0)
    expect(packaged.filter(isZodTest)).toEqual([])
  })

  it('仅排除 Zod 测试，其他原有运行时文件和资源全部保留', async () => {
    const before = await enumerateZod(product.build.files.filter((pattern) => !pattern.startsWith('!')))
    const after = await enumerateZod(product.build.files)
    expect(before.filter(isZodTest).length).toBeGreaterThan(0)
    expect(after).toEqual(before.filter((path) => !isZodTest(path)))
    for (const path of ['package.json', 'index.js', 'index.cjs', 'compile.js', 'compile.cjs',
      'v3/index.js', 'v4/index.js', 'v4/core/index.js', 'v4/core/index.cjs',
      'v4/locales/en.js', 'v4/locales/zh-CN.js', 'src/index.ts', 'src/compile.ts']) {
      expect(after).toContain(path)
    }
  })
})
