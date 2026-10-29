import { describe, expect, it } from 'vitest'
import { addSearchHistory, MAX_SEARCH_HISTORY_QUERY_BYTES, normalizeSearchHistoryKey, removeSearchHistory, sanitizeSearchHistory, validateSearchHistoryQuery } from '../src/shared/search-history'

describe('最近搜索的确定性规则', () => {
  it('新搜索置顶，连续输入或读取本身没有写入副作用', () => {
    const existing = ['旧搜索']
    expect(addSearchHistory(existing, '  中文查询😀  ')).toEqual(['中文查询😀', '旧搜索'])
    expect(existing).toEqual(['旧搜索'])
  })
  it('仅折叠去重键的空白，保存并重搜最近实际提交词', () => {
    expect(normalizeSearchHistoryKey(' \t"foo  bar"\n 学习  ')).toBe('"foo bar" 学习')
    expect(addSearchHistory(['"foo bar" 学习', '其它'], ' "foo  bar"\n学习 ')).toEqual(['"foo  bar"\n学习', '其它'])
    expect(validateSearchHistoryQuery(' "foo  bar" ')).toBe('"foo  bar"')
  })
  it('重复查询移动到最前，始终最多六条，最旧记录淘汰', () => {
    let values: string[] = []
    for (let n = 1; n <= 8; n++) values = addSearchHistory(values, '查询' + n)
    expect(values).toEqual(['查询8', '查询7', '查询6', '查询5', '查询4', '查询3'])
    expect(addSearchHistory(values, '查询4')).toEqual(['查询4', '查询8', '查询7', '查询6', '查询5', '查询3'])
  })
  it('大小写和字符宽度不擅自视为等价，保留原检索意义', () => {
    expect(addSearchHistory(['AI', 'ＡＩ'], 'ai')).toEqual(['ai', 'AI', 'ＡＩ'])
  })
  it('损坏或非字符串历史不带出正文对象，读取结果仍有界且唯一', () => {
    expect(sanitizeSearchHistory(null)).toEqual([])
    expect(sanitizeSearchHistory({ query: '不会保存', content: '正文' })).toEqual([])
    expect(sanitizeSearchHistory(['  查询  ', '', '查询', { content: '正文' }, 2, '新词'])).toEqual(['查询', '新词'])
    expect(sanitizeSearchHistory(Array.from({ length: 20 }, (_, n) => '查询' + n))).toHaveLength(6)
  })
  it('单条删除按相同空白键生效，删除不存在的词不影响其它记录', () => {
    expect(removeSearchHistory(['A   B', '其它'], ' A B ')).toEqual(['其它'])
    expect(removeSearchHistory(['A', 'B'], 'C')).toEqual(['A', 'B'])
  })
  it('历史条目超限明确拒绝，不静默截断；UTF8按字节计量', () => {
    expect(validateSearchHistoryQuery('x'.repeat(MAX_SEARCH_HISTORY_QUERY_BYTES))).toHaveLength(MAX_SEARCH_HISTORY_QUERY_BYTES)
    expect(() => addSearchHistory([], 'x'.repeat(MAX_SEARCH_HISTORY_QUERY_BYTES + 1))).toThrow('未保存')
    expect(() => validateSearchHistoryQuery('中'.repeat(2731))).toThrow('未保存')
    expect(sanitizeSearchHistory(['x'.repeat(MAX_SEARCH_HISTORY_QUERY_BYTES + 1), '保留'])).toEqual(['保留'])
  })
  it.each([undefined, null, 42, {}, ' ', '\t\n'])('非法历史写入输入明确拒绝 %#', value => {
    expect(() => validateSearchHistoryQuery(value)).toThrow('搜索词不能为空')
  })
})
