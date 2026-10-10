// 内部验收编排；只上传摘要和非敏感架构诊断，临时数据库与证据不进入报告目录。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const reports = path.resolve('stage2c-reports')
fs.mkdirSync(reports, { recursive: true })
const result = { RUNNER_LABEL: 'macos-15', RUNNER_OS: process.platform, RUNNER_ARCH: process.arch,
  NODE_VERSION: process.version, NODE_ICU_VERSION: process.versions.icu, NODE_ARCH: process.arch, MAC_TEST_TIMEOUT_SETTING: 15000,
  FIRST_RUN_ID: 38035043884, SECOND_RUN_ID: process.env.GITHUB_RUN_ID, PHYSICAL_MAC_UI_VALIDATION: 'PENDING',
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
    passedFiles: (json.testResults ?? []).filter(file => file.status === 'passed').length,
    failedFiles: (json.testResults ?? []).filter(file => file.status === 'failed').length,
    files: (json.testResults ?? []).map(file => ({ file: path.relative(process.cwd(), file.name),
      passed: (file.assertionResults ?? []).filter(test => test.status === 'passed').length,
      skipped: (file.assertionResults ?? []).filter(test => test.status === 'pending' || test.status === 'skipped' || test.status === 'todo').length,
      failed: (file.assertionResults ?? []).filter(test => test.status === 'failed').length })),
    skippedCases: (json.testResults ?? []).flatMap(file => (file.assertionResults ?? [])
      .filter(test => test.status === 'pending' || test.status === 'skipped' || test.status === 'todo')
      .map(test => ({ file: path.relative(process.cwd(), file.name), test: test.fullName }))),
    failures: (json.testResults ?? []).filter(file => file.status !== 'passed').map(file => ({
      file: path.relative(process.cwd(), file.name), status: file.status,
      tests: (file.assertionResults ?? []).filter(test => test.status === 'failed').map(test => ({ test: test.fullName,
        timeout: /timed out|timeout/i.test((test.failureMessages ?? []).join('\n')) }))
    })) }
  save(name, summary); return summary
}
const windowsCases = JSON.parse(fs.readFileSync('.github/scripts/macos-stage2c/windows-only-cases.json', 'utf8'))
function classifySkipped(summary) {
  return (summary.skippedCases ?? []).map(test => {
    const known = windowsCases.find(row => row.file === test.file && row.test === test.test)
    return { ...test, category: known ? 'WINDOWS_ONLY_CONTRACT' : 'OTHER', reason: known?.reason ?? '未审核的跳过项' }
  })
}
function suitePassed(summary, names) {
  return !summary.reportMissing && names.every(name => {
    const file = summary.files?.find(row => row.file === 'tests/' + name)
    return file?.passed > 0 && file.failed === 0
      && classifySkipped(summary).filter(row => row.file === file.file).every(row => row.category === 'WINDOWS_ONLY_CONTRACT')
  })
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
  const base = '4a7823fad1820b5c71a8584dab213cc46ff11477'
  result.SEARCH_COMMIT = base
  result.STABILIZATION_COMMIT = '0ef3a79ba5c00d9e60aa56945a5f266bcf07a70b'
  assert.equal(commandText('git', ['rev-parse', base + '^']), result.STABILIZATION_COMMIT)
  commandText('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
  const changed = commandText('git', ['diff', '--name-only', base, 'HEAD']).split('\n')
  assert.ok(changed.length > 0 && changed.every(file => file === '.github/workflows/macos-stage2c-validation.yml'
    || file.startsWith('.github/scripts/macos-stage2c/')))
  result.PRODUCT_CODE_CHANGED_AFTER_SEARCH_COMMIT = 'NO'
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
  const searchReports = []
  for (const [label, runtime, env] of [['node', process.execPath, {}], ['electron', electron, { ELECTRON_RUN_AS_NODE: '1' }]]) {
    const destination = path.join(reports, label + '-search-runtime.json')
    const execution = await run(runtime, [core, 'search', destination], { env, timeout: 120000 })
    assert.equal(execution.code, 0, label + ' 候选采集失败')
    const report = JSON.parse(fs.readFileSync(destination, 'utf8'))
    assert.equal(report.runtime.platform, 'darwin'); assert.equal(report.runtime.arch, 'arm64')
    searchReports.push(report)
  }
  result.ELECTRON_NODE_VERSION = searchReports[1].runtime.node
  result.ELECTRON_NODE_ICU_VERSION = searchReports[1].runtime.icu
  result.SQLITE_VERSION = searchReports.map(report => ({ runtime: report.runtime.electron ? 'electron' : 'node', version: report.runtime.sqlite }))
  const candidateView = scenarios => scenarios.map(({ name, query, generatedCandidates, allCandidates, top24, top12 }) =>
    ({ name, query, generatedCandidates, allCandidates, top24, top12 }))
  result.ICU_CANDIDATE_GENERATION = JSON.stringify(candidateView(searchReports[0].scenarios)) === JSON.stringify(candidateView(searchReports[1].scenarios)) ? 'PASS' : 'FAIL'
  assert.equal(result.ICU_CANDIDATE_GENERATION, 'PASS', '两个真实运行时生成的候选或元数据不同；禁止产品放行')
  const windowsBaseline = JSON.parse(fs.readFileSync('.github/scripts/macos-stage2c/windows-search-baseline.json', 'utf8'))
  assert.equal(windowsBaseline.sourceCommit, base)
  const comparable = row => ({ allCandidates: row.allCandidates, top24: row.top24, top12: row.top12,
    ftsExpression: row.ftsExpression, results: row.results, dateRange: row.dateRange })
  for (const [name, field] of [['十四词', 'MACOS_LONG_QUERY_14_MATCHES_WINDOWS'], ['二十六词', 'MACOS_LONG_QUERY_26_MATCHES_WINDOWS'],
    ['车辆短查询', 'VEHICLE_SHORT_QUERY'], ['拼车短查询', 'CARPOOL_SHORT_QUERY']]) {
    const expected = windowsBaseline.scenarios.find(row => row.name === name)
    result[field] = expected && searchReports.every(report => JSON.stringify(comparable(report.scenarios.find(row => row.name === name))) === JSON.stringify(comparable(expected))) ? 'PASS' : 'FAIL'
    assert.equal(result[field], 'PASS', name + ' 与已验收 Windows 结果不一致')
  }
  result.MACOS_SEARCH_SHORT_QUERY_REGRESSION = 'PASS'
  result.NATIVE_SEARCH_SQL = searchReports.every(report => report.scenarios.every(row => row.stableFtsSql)) ? 'PASS' : 'FAIL'
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
  assert.ok(nodeRun.code === 0 && electronRun.code === 0 && gates.every(name => result[name] === 'PASS'), '真实原生共享语义失败；停止产品放行')
  result.MACOS_MANUAL_JSON_NATIVE_PROBE = result.MACOS_MANUAL_JSON_CORE
  const restartResults = []
  for (const [runtime, env] of [[process.execPath, {}], [electron, { ELECTRON_RUN_AS_NODE: '1' }]]) {
    const directory = fs.mkdtempSync(path.join(testsTemp, 'privateradar-stage2c-restart-'))
    const a = await run(runtime, [core, 'restart-a', directory], { env })
    const b = await run(runtime, [core, 'restart-b', directory], { env })
    restartResults.push(a.code === 0 && b.code === 0)
  }
  result.MACOS_RESTART_PERSISTENCE = restartResults.every(Boolean) ? 'PASS' : 'FAIL'
  const searchSuite = ['search-quality.test.ts', 'search-relative-date.test.ts', 'chat-search.test.ts', 'chat-search-v2.test.ts',
    'query-understanding-natural-language.test.ts', 'query-understanding-empty-names.test.ts', 'time-semantics.test.ts',
    'message-provenance.test.ts', 'alpha3-correctness.test.ts', 'feedback.test.ts', 'workbuddy-adapter.test.ts', 'workbuddy-mcp.test.ts']
  const targetedFiles = [...searchSuite, 'search-term-determinism.test.ts', 'search-term-order-neutrality.test.ts',
    'manual-json-evidence-core.test.ts', 'manual-json-import-report.test.tsx', 'macos-platform-boundaries.test.ts',
    'macos-platform-startup.test.ts', 'macos-platform-ui.test.tsx', 'request-scoped-windows-runtime.test.ts']
  const targetedJson = path.join(temporary, 'targeted.json')
  const targeted = await run('npm', ['test', '--', ...targetedFiles.map(name => 'tests/' + name),
    '--maxWorkers', '2', '--testTimeout', '15000', '--reporter=default', '--reporter=json', '--outputFile=' + targetedJson], { timeout: 420000 })
  result.MACOS_TARGETED_TESTS = summarizeTests(targetedJson, 'targeted-tests-summary.json')
  const manualSuite = result.MACOS_TARGETED_TESTS.files?.find(file => file.file.endsWith('manual-json-evidence-core.test.ts'))
  const manualSkipped = classifySkipped(result.MACOS_TARGETED_TESTS).filter(row => row.file.endsWith('manual-json-evidence-core.test.ts'))
  result.MACOS_MANUAL_JSON_SHARED_TESTS = { passed: manualSuite?.passed, skipped: manualSkipped.filter(row => row.category === 'OTHER').length,
    failed: manualSuite?.failed, windowsOnlySkipped: manualSkipped.filter(row => row.category === 'WINDOWS_ONLY_CONTRACT').length }
  result.MACOS_MANUAL_JSON_SHARED_SUITE = manualSuite?.passed === 31 && manualSuite.failed === 0 && manualSkipped.length === 2
    && manualSkipped.every(row => row.category === 'WINDOWS_ONLY_CONTRACT') ? 'PASS' : 'FAIL'
  result.MACOS_MANUAL_JSON_CORE = result.MACOS_MANUAL_JSON_NATIVE_PROBE === 'PASS'
    && result.MACOS_MANUAL_JSON_SHARED_SUITE === 'PASS' ? 'PASS' : 'FAIL'
  result.MACOS_WORKBUDDY_STARTUP_TEST = result.MACOS_TARGETED_TESTS.failures?.some(file => file.file.endsWith('macos-platform-startup.test.ts')) || result.MACOS_TARGETED_TESTS.reportMissing ? 'FAIL' : 'PASS'
  for (const [field, names] of [
    ['DETERMINISTIC_COMPARATOR', ['search-term-determinism.test.ts']],
    ['MACOS_SEARCH_LOCALE_INDEPENDENCE', ['search-term-order-neutrality.test.ts']],
    ['MACOS_SEARCH_TERM_ORDER_NEUTRALITY', ['search-term-order-neutrality.test.ts']],
    ['MACOS_SEARCH_QUALITY_ACCEPTANCE', ['search-quality.test.ts']],
    ['MACOS_SEARCH_REACCEPTANCE', searchSuite], ['MACOS_SEARCH_DATE_SEMANTICS', ['search-relative-date.test.ts', 'time-semantics.test.ts']],
    ['MACOS_MESSAGE_PROVENANCE', ['message-provenance.test.ts']]
  ]) result[field] = suitePassed(result.MACOS_TARGETED_TESTS, names) ? 'PASS' : 'FAIL'
  result.MACOS_FTS_STABLE_ORDER = result.NATIVE_SEARCH_SQL === 'PASS' && result.MACOS_SEARCH_TERM_ORDER_NEUTRALITY === 'PASS' ? 'PASS' : 'FAIL'
  const fullJson = path.join(temporary, 'full.json')
  const full = await run('npm', ['test', '--', '--maxWorkers', '2', '--testTimeout', '15000', '--reporter=default', '--reporter=json', '--outputFile=' + fullJson], { timeout: 900000 })
  result.MACOS_FULL_TESTS = summarizeTests(fullJson, 'full-tests-summary.json')
  result.MAC_WINDOWS_ONLY_SKIPPED_TESTS = classifySkipped(result.MACOS_FULL_TESTS)
  result.SKIPPED_TESTS_BY_REASON = { WINDOWS_ONLY_CONTRACT: result.MAC_WINDOWS_ONLY_SKIPPED_TESTS.filter(row => row.category === 'WINDOWS_ONLY_CONTRACT').length,
    OTHER: result.MAC_WINDOWS_ONLY_SKIPPED_TESTS.filter(row => row.category === 'OTHER').length }
  result.MAC_WINDOWS_ONLY_SKIPPED_COUNT = result.SKIPPED_TESTS_BY_REASON.WINDOWS_ONLY_CONTRACT
  result.SHARED_TESTS_SKIPPED_FOR_MAC = result.SKIPPED_TESTS_BY_REASON.OTHER
  result.MAC_TEST_TIMEOUT_FAILURES = [result.MACOS_TARGETED_TESTS, result.MACOS_FULL_TESTS].flatMap(summary =>
    (summary.failures ?? []).flatMap(file => file.tests.filter(test => test.timeout).map(test => ({ file: file.file, test: test.test }))))
  if (targeted.timedOut || full.timedOut) result.MAC_TEST_TIMEOUT_FAILURES.push({ file: '验收编排', test: '测试进程超出 CI 步骤执行时限' })
  for (const [field, names] of [['MACOS_CONTEXT_SHARED', ['message-provenance.test.ts', 'keyword-radar-desktop.test.ts', 'commitment-review-desktop.test.ts']],
    ['MACOS_KEYWORD_SHARED', ['keyword-radar-matcher.test.ts', 'keyword-radar-processor.test.ts', 'keyword-radar-post-import.test.ts']],
    ['MACOS_COMMITMENT_SHARED', ['commitment-matcher.test.ts', 'commitment-processor.test.ts', 'commitment-review-desktop.test.ts']]
  ]) result[field] = suitePassed(result.MACOS_FULL_TESTS, names) ? 'PASS' : 'FAIL'
  save('skipped-tests-by-reason.json', { counts: result.SKIPPED_TESTS_BY_REASON, tests: result.MAC_WINDOWS_ONLY_SKIPPED_TESTS })
  assert.equal(result.SHARED_TESTS_SKIPPED_FOR_MAC, 0, '共享或未审核测试被跳过')
  assert.equal(result.MAC_WINDOWS_ONLY_SKIPPED_COUNT, windowsCases.length, '平台专属跳过名单与运行结果不一致')
  assert.ok(targeted.code === 0 && full.code === 0, '共享回归失败；保留报告并停止，不提高时限或修改产品')
  result.SHARED_TESTS = full.code === 0 ? 'PASS' : 'FAIL'
  for (const field of ['SOURCE_PRIORITY', 'PHRASE_PRIORITY', 'CONDITIONAL_LENGTH', 'QUERY_POSITION', 'LEXICAL_TIEBREAK', 'TOP24', 'TOP12']) {
    result[field] = result.DETERMINISTIC_COMPARATOR
  }
  result.MACOS_SYMLINK_PRODUCT_BEHAVIOR = result.MACOS_SYMLINK_BOUNDARY
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
  const required = [...gates, 'ICU_CANDIDATE_GENERATION', 'MACOS_MANUAL_JSON_SHARED_SUITE', 'DETERMINISTIC_COMPARATOR',
    'MACOS_SEARCH_LOCALE_INDEPENDENCE', 'MACOS_SEARCH_TERM_ORDER_NEUTRALITY', 'MACOS_FTS_STABLE_ORDER',
    'MACOS_SEARCH_SHORT_QUERY_REGRESSION', 'MACOS_LONG_QUERY_14_MATCHES_WINDOWS', 'MACOS_LONG_QUERY_26_MATCHES_WINDOWS',
    'MACOS_SEARCH_QUALITY_ACCEPTANCE', 'MACOS_SEARCH_REACCEPTANCE', 'MACOS_SEARCH_DATE_SEMANTICS', 'MACOS_MESSAGE_PROVENANCE',
    'MACOS_CONTEXT_SHARED', 'MACOS_KEYWORD_SHARED', 'MACOS_COMMITMENT_SHARED', 'MACOS_RESTART_PERSISTENCE', 'MACOS_TYPECHECK', 'MACOS_SOURCE_BUILD']
  const failed = required.some(name => result[name] !== 'PASS') || result.ELECTRON_RUNTIME_SMOKE === 'FAIL'
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
