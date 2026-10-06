import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { matchKeywordSnapshot } from '../src/main/keyword-radar/matcher'
import { normalizeKeywordMatchTextV1, normalizeKeywordTermV1 } from '../src/main/keyword-radar/normalization'
import type { RulesSnapshot } from '../src/main/keyword-radar/contracts'

function rules(terms: string[]): RulesSnapshot {
  return { snapshot_version: 1, matching_version: 'literal-nfc-ascii-v1', groups: [{
    group_id: 'group', group_name: '隔离分组',
    terms: terms.map((term, index) => ({
      term_id: String(index), term: term.trim().normalize('NFC'), normalized_term: normalizeKeywordTermV1(term)
    }))
  }] }
}
describe('关键词雷达确定性包含匹配', () => {
  it.each([
    ['南京', '明天南京回光山', true], ['南京', '明天回光山', false],
    ['Codex', 'Codex', true], ['Codex', 'codex', true], ['Codex', 'CODEX', true],
    ['É', 'é', false], ['é', 'e\u0301', true], ['é', 'É', false],
    ['Ｃｏｄｅｘ', 'Codex', false], ['后', '後', false],
    ['Codex CLI', 'Codex  CLI', false], ['Codex CLI', 'Codex\nCLI', false],
    ['Codex CLI', 'Codex CLI', true], ['南京/光山', '南京光山', false],
    ['南京/光山', '南京/光山', true], ['🚗', '拼车🚗', true], ['🚗', '拼车🚙', false],
    ['图片', '[图片]', true], ['南京', '[图片]', false], ['.', 'abc', false], ['a*b', 'a*b', true]
  ])('关键词 %s 对正文 %s 的包含结果为 %s', (term, body, expected) => {
    expect(matchKeywordSnapshot(body, rules([term])).length > 0).toBe(expected)
  })
  it('正文不去首尾空白，保留空格、换行、标点和表情', () => {
    expect(normalizeKeywordMatchTextV1(' \nCODEX  CLI，🚗 \n')).toBe(' \ncodex  cli，🚗 \n')
    expect(normalizeKeywordTermV1(' \nCODEX  CLI \n')).toBe('codex  cli')
  })
  it('同组多词及重叠词只生成一个结果，按冻结顺序完整记录且不修改输入', () => {
    const snapshot = rules(['MCP', 'Codex CLI', 'Codex'])
    const before = JSON.stringify(snapshot)
    const result = matchKeywordSnapshot('Codex CLI 支持 MCP', snapshot)
    expect(result).toHaveLength(1)
    expect(result[0].matched_terms.terms.map(term => term.term)).toEqual(['MCP', 'Codex CLI', 'Codex'])
    expect(JSON.stringify(snapshot)).toBe(before)
    expect(matchKeywordSnapshot('Codex CLI 支持 MCP', snapshot)).toEqual(result)
  })
  it('多个分组分别命中，空快照和空组不产生结果', () => {
    const snapshot = rules(['Codex'])
    snapshot.groups.push({ ...rules(['MCP']).groups[0], group_id: 'second' })
    expect(matchKeywordSnapshot('Codex 支持 MCP', snapshot).map(match => match.group_id)).toEqual(['group', 'second'])
    expect(matchKeywordSnapshot('Codex', { ...snapshot, groups: [] })).toEqual([])
    expect(matchKeywordSnapshot('Codex', rules([]))).toEqual([])
  })
  it('记录 400 个词与 400 条正文的实际匹配耗时，不使用专用索引', () => {
    const snapshot = rules(Array.from({ length: 400 }, (_, index) => `业务关键词-${String(index).padStart(4, '0')}`))
    const start = performance.now()
    let hits = 0
    for (let index = 0; index < 400; index++) {
      hits += matchKeywordSnapshot(`隔离聊天：业务关键词-${String(index).padStart(4, '0')}，其他正文🚗`, snapshot).length
    }
    const elapsed = performance.now() - start
    console.info(`关键词雷达性能：400 词 × 400 正文，${elapsed.toFixed(3)} 毫秒`)
    expect(hits).toBe(400)
    expect(elapsed).toBeLessThan(5000)
  })
})
