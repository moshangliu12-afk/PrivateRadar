// 只审计真实测试结果；不改写测试结果、断言或平台跳过条件。
export function classifyTimeout(messages) {
  const text = (messages ?? []).join('\n')
  const actual = /^\s*(?:Error:\s*)?(?:Test|Hook) timed out in [\d,]+ms(?:[.\s]|$)/im.test(text)
  return { timeout: actual, classificationFalsePositive: /timed out|timeout/i.test(text) && !actual }
}
export function auditShared(summary, manifest) {
  const units = manifest.units.map(unit => {
    const tests = unit.tests.map(name => {
      const matches = (summary.cases ?? []).filter(test => test.file === unit.file && test.test === name)
      return { file: unit.file, test: name, status: matches.length === 1 ? matches[0].status : 'missing' }
    })
    return { ...unit, tests, status: tests.every(test => test.status === 'passed') ? 'PASS' : 'FAIL' }
  })
  const tests = units.flatMap(unit => unit.tests)
  return { status: !summary.reportMissing && units.every(unit => unit.status === 'PASS') ? 'PASS' : 'FAIL',
    callbacks: units.length, expectedCases: tests.length,
    passed: tests.filter(test => test.status === 'passed').length,
    skipped: tests.filter(test => ['pending', 'skipped', 'todo'].includes(test.status)).length,
    failed: tests.filter(test => test.status === 'failed').length,
    missing: tests.filter(test => test.status === 'missing').length,
    groups: Object.fromEntries(Object.entries(manifest.groups).map(([name, ids]) =>
      [name, ids.every(id => units.find(unit => unit.unit === id)?.status === 'PASS') ? 'PASS' : 'FAIL'])), units }
}
