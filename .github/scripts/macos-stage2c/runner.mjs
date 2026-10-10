// 内部验收编排；只上传摘要和非敏感架构诊断，临时数据库与证据不进入报告目录。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const reports = path.resolve('.stage2c-reports')
fs.mkdirSync(reports, { recursive: true })
const result = { RUNNER_LABEL: 'macos-15', RUNNER_OS: process.platform, RUNNER_ARCH: process.arch,
  NODE_VERSION: process.version, NODE_ARCH: process.arch, PHYSICAL_MAC_UI_VALIDATION: 'PENDING',
  FINDER_MANUAL_OPEN_VALIDATED: 'NO', PRODUCT_CODE_FIX_APPLIED: 'NO', WINDOWS_PRODUCT_SOURCE_CHANGED: 'NO',
  DMG_BUILT: 'NO', SIGNING_ATTEMPTED: 'NO', NOTARIZATION_ATTEMPTED: 'NO', GITHUB_RELEASE_CREATED: 'NO' }
const save = (name, value) => fs.writeFileSync(path.join(reports, name), JSON.stringify(value, null, 2) + '\n')
const commandText = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
async function run(command, args, options = {}) {
  console.log('\n执行：' + command + ' ' + args.join(' '))
  return await new Promise(resolve => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => {
      destination.write(chunk); output = (output + chunk.toString()).slice(-100000)
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, options.timeout ?? 120000)
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, output: String(error), timedOut: false }) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, output, signal, timedOut }) })
  })
}
function summarizeTests(raw, name) {
  if (!fs.existsSync(raw)) return { status: 'FAIL', reportMissing: true }
  const json = JSON.parse(fs.readFileSync(raw, 'utf8'))
  const summary = { passed: json.numPassedTests, skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0), failed: json.numFailedTests,
    passedFiles: json.numPassedTestSuites, failedFiles: json.numFailedTestSuites,
    failures: (json.testResults ?? []).filter(file => file.status !== 'passed').map(file => ({
      file: path.relative(process.cwd(), file.name), status: file.status,
      tests: (file.assertionResults ?? []).filter(test => test.status === 'failed').map(test => test.fullName)
    })) }
  save(name, summary); return summary
}
async function main() {
  // 环境不符时，不安装依赖或继续测试。
  for (const [command, args] of [['uname', ['-a']], ['uname', ['-m']], ['sw_vers', []], ['node', ['--version']], ['npm', ['--version']]]) {
    console.log(commandText(command, args))
  }
  console.log('process.arch = ' + process.arch); console.log('process.platform = ' + process.platform)
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  assert.equal(process.version, 'v24.14.0')
  result.RUNNER_HARDWARE_INFO = commandText('sysctl', ['-n', 'machdep.cpu.brand_string'])
  result.MACOS_VERSION = commandText('sw_vers', ['-productVersion'])
  result.HEAD = commandText('git', ['rev-parse', 'HEAD']); assert.equal(result.HEAD, process.env.GITHUB_SHA)
  result.BRANCH = process.env.GITHUB_REF_NAME; assert.equal(result.BRANCH, 'feat/macos-stage2b-platform')
  const base = '496576bd894f516b01e567bae0055e0a7a71d627'
  commandText('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
  const changed = commandText('git', ['diff', '--name-only', base, 'HEAD']).split('\n')
  assert.ok(changed.length > 0 && changed.every(file => file === '.github/workflows/macos-stage2c-validation.yml' || file.startsWith('.github/scripts/macos-stage2c/')))
  result.WORKFLOW_FILES_CHANGED = changed
  assert.equal(commandText('git', ['status', '--porcelain', '--untracked-files=no']), '')
  assert.equal(commandText('git', ['rev-parse', 'v0.2.0-alpha.20^{}']), '34e0a292416e7720585e3aabf84e5f1d857cfc36')
  const tempParent = fs.realpathSync(process.env.RUNNER_TEMP)
  const temporary = fs.mkdtempSync(path.join(tempParent, 'privateradar-stage2c-ci-'))
  const testsTemp = path.join(temporary, '运行临时目录'); fs.mkdirSync(testsTemp)
  process.env.TMPDIR = testsTemp
  result.RUNNER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
  result.RUNNER_DATE = commandText('date', ['+%Y-%m-%dT%H:%M:%S%z %Z'])
  const filesystem = commandText('df', ['-P', testsTemp])
  result.RUNNER_FILESYSTEM = filesystem
  result.RUNNER_FILESYSTEM_INFO = commandText('diskutil', ['info', filesystem.split('\n')[1].trim().split(/\s+/)[0]])
  console.log(JSON.stringify(result, null, 2)); save('environment.json', result)
  assert.ok(!fs.existsSync('node_modules'))
  const install = await run('npm', ['ci'], { timeout: 600000 })
  result.MACOS_CLEAN_NPM_INSTALL = install.code === 0 ? 'PASS' : 'FAIL'
  if (install.code !== 0) throw new Error('干净依赖安装失败；停止依赖运行检查')
  assert.equal(commandText('git', ['diff', '--name-only']), '')
  const electron = require('electron')
  result.ELECTRON_VERSION = require('electron/package.json').version
  const architecture = {}
  for (const [label, binary] of [
    ['node', process.execPath], ['electron', electron],
    ['electronFramework', path.resolve('node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')],
    ['esbuild', path.resolve('node_modules/@esbuild/darwin-arm64/bin/esbuild')]
  ]) {
    const info = commandText('file', [binary]); console.log(info)
    assert.match(info, /arm64/); assert.doesNotMatch(binary, /\.exe$/i); architecture[label] = info
  }
  save('binary-architecture.json', architecture)
  const { build } = await import('esbuild')
  const core = path.join(temporary, 'runtime-core.cjs')
  await build({ entryPoints: ['./.github/scripts/macos-stage2c/runtime-core.ts'], outfile: core, platform: 'node', format: 'cjs', bundle: true, target: 'node24' })
  const nodeReport = path.join(reports, 'node-runtime.json'), electronReport = path.join(reports, 'electron-node-runtime.json')
  const nodeRun = await run(process.execPath, [core, 'validate', nodeReport], { timeout: 180000 })
  const electronRun = await run(electron, [core, 'validate', electronReport], { env: { ELECTRON_RUN_AS_NODE: '1' }, timeout: 180000 })
  result.NODE_CORE_TESTS = nodeRun.code === 0 ? 'PASS' : 'FAIL'
  result.ELECTRON_NODE_CORE_TESTS = electronRun.code === 0 ? 'PASS' : 'FAIL'
  const nodeFields = fs.existsSync(nodeReport) ? JSON.parse(fs.readFileSync(nodeReport, 'utf8')) : {}
  const electronFields = fs.existsSync(electronReport) ? JSON.parse(fs.readFileSync(electronReport, 'utf8')) : {}
  const gates = ['MACOS_SQLITE_RUNTIME', 'MACOS_FTS5_RUNTIME', 'MACOS_MANUAL_JSON_CORE', 'MACOS_EVIDENCE_FILESYSTEM', 'MACOS_NON_OVERWRITE_PUBLISH',
    'MACOS_SYMLINK_BOUNDARY', 'MACOS_TIME_RUNTIME', 'MACOS_EVIDENCE_NAVIGATION_LOGIC', 'MACOS_DIRECTORY_EVIDENCE_POLICY', 'MACOS_WORKBUDDY_GUARD']
  for (const name of gates) result[name] = nodeFields[name] === 'PASS' && electronFields[name] === 'PASS' ? 'PASS' : 'FAIL'
  const restartResults = []
  for (const [runtime, env] of [[process.execPath, {}], [electron, { ELECTRON_RUN_AS_NODE: '1' }]]) {
    const directory = fs.mkdtempSync(path.join(testsTemp, 'privateradar-stage2c-restart-'))
    const a = await run(runtime, [core, 'restart-a', directory], { env })
    const b = await run(runtime, [core, 'restart-b', directory], { env })
    restartResults.push(a.code === 0 && b.code === 0)
  }
  result.MACOS_RESTART_PERSISTENCE = restartResults.every(Boolean) ? 'PASS' : 'FAIL'
  const targetedJson = path.join(temporary, 'targeted.json')
  const targeted = await run('npm', ['test', '--', 'tests/manual-json-evidence-core.test.ts', 'tests/manual-json-import-report.test.tsx',
    'tests/macos-platform-boundaries.test.ts', 'tests/macos-platform-startup.test.ts', 'tests/macos-platform-ui.test.tsx',
    'tests/chat-search.test.ts', 'tests/chat-search-v2.test.ts', 'tests/time-semantics.test.ts',
    '--maxWorkers', '2', '--testTimeout', '30000', '--reporter=default', '--reporter=json', '--outputFile=' + targetedJson], { timeout: 420000 })
  result.MACOS_TARGETED_TESTS = summarizeTests(targetedJson, 'targeted-tests-summary.json')
  result.MACOS_WORKBUDDY_STARTUP_TEST = result.MACOS_TARGETED_TESTS.failures?.some(file => file.file.endsWith('macos-platform-startup.test.ts')) || result.MACOS_TARGETED_TESTS.reportMissing ? 'FAIL' : 'PASS'
  const fullJson = path.join(temporary, 'full.json')
  const full = await run('npm', ['test', '--', '--maxWorkers', '2', '--testTimeout', '30000', '--reporter=default', '--reporter=json', '--outputFile=' + fullJson], { timeout: 900000 })
  result.MACOS_FULL_TESTS = summarizeTests(fullJson, 'full-tests-summary.json')
  result.SHARED_TESTS = full.code === 0 ? 'PASS' : 'FAIL'
  result.MACOS_TYPECHECK = (await run('npm', ['run', 'typecheck'], { timeout: 120000 })).code === 0 ? 'PASS' : 'FAIL'
  const sourceBuild = await run('npm', ['run', 'build'], { timeout: 180000 })
  result.MACOS_SOURCE_BUILD = sourceBuild.code === 0 ? 'PASS' : 'FAIL'
  if (sourceBuild.code === 0) {
    const smokeDirectory = fs.mkdtempSync(path.join(testsTemp, 'privateradar-stage2c-electron-'))
    const smoke = await run(electron, ['.github/scripts/macos-stage2c/electron-smoke.cjs'], {
      env: { ELECTRON_RUN_AS_NODE: '', PRIVATERADAR_CI_SMOKE_DIRECTORY: smokeDirectory, PRIVATERADAR_CI_SMOKE_REPORT: path.join(reports, 'electron-smoke.json') }, timeout: 40000
    })
    result.ELECTRON_RUNTIME_SMOKE = smoke.code === 0 ? 'PASS' : /WindowServer|cannot connect to window server|failed to connect to.*display|等待图形会话超时/i.test(smoke.output) ? 'LIMITED_BY_CI' : 'FAIL'
  } else result.ELECTRON_RUNTIME_SMOKE = 'FAIL'
  assert.equal(commandText('git', ['diff', '--name-only']), '')
  const failed = gates.some(name => result[name] !== 'PASS') || result.MACOS_RESTART_PERSISTENCE !== 'PASS' || targeted.code !== 0 || full.code !== 0 ||
    result.MACOS_TYPECHECK !== 'PASS' || result.MACOS_SOURCE_BUILD !== 'PASS' || result.ELECTRON_RUNTIME_SMOKE === 'FAIL'
  result.MACOS_STAGE2C_A_CI_RUNTIME = failed ? 'FAIL' : result.ELECTRON_RUNTIME_SMOKE === 'LIMITED_BY_CI' ? 'PASS_WITH_LIMITATION' : 'PASS'
  result.REAL_MACOS_ARM64_RUNTIME_VALIDATED = failed ? 'NO' : 'YES'
  process.exitCode = failed ? 1 : 0
}
try { await main() } catch (error) { console.error(error); result.MACOS_STAGE2C_A_CI_RUNTIME = 'FAIL'; result.CI_FAILURE = String(error); process.exitCode = 1 }
finally {
  save('summary.json', result)
  const text = '```json\n' + JSON.stringify(result, null, 2) + '\n```\n'
  fs.writeFileSync(path.join(reports, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(JSON.stringify(result, null, 2))
}
