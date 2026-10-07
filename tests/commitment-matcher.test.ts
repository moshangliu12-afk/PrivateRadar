import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { COMMITMENT_RULE_IDS, COMMITMENT_RULE_VERSION, matchCommitmentBody } from '../src/main/commitment/matcher'

describe('承诺候选项固定规则匹配', () => {
  it.each([
    ['我会把文件发给你', 'self_will_action'], ['我会整理完发你', 'self_will_action'],
    ['我会回复你', 'self_will_action'], ['我会处理这个问题', 'self_will_action'],
    ['我会联系他确认', 'self_will_action'], ['我会补充资料', 'self_will_action'], ['我会修改后提交', 'self_will_action'],
    ['我来处理这个问题', 'self_take_action'], ['我来处理', 'self_take_action'], ['我来确认', 'self_take_action'],
    ['我来整理', 'self_take_action'], ['我来回复', 'self_take_action'], ['我来联系', 'self_take_action'],
    ['我来修改', 'self_take_action'], ['我来提交', 'self_take_action'], ['我来补充', 'self_take_action'], ['我来核对', 'self_take_action'],
    ['我负责这个部分', 'self_responsibility'], ['我负责后端修改', 'self_responsibility'],
    ['这块我负责', 'self_responsibility'], ['这个部分我负责', 'self_responsibility'], ['这个问题我负责处理', 'self_responsibility'],
    ['我晚点给你发', 'self_future_action'], ['我等会把资料发你', 'self_future_action'],
    ['我稍后回复你', 'self_future_action'], ['我之后处理一下这个问题', 'self_future_action'],
    ['我会晚点提供资料', 'self_future_action']
  ])('明确第一人称正例：%s', (body, ruleId) => {
    const result = matchCommitmentBody(body)
    expect(result).toEqual({ rule_id: ruleId, reason_code: `explicit_${ruleId}`, rule_version: COMMITMENT_RULE_VERSION })
    expect(Object.keys(result!).sort()).toEqual(['reason_code', 'rule_id', 'rule_version'])
  })
  it.each([
    '我不会处理这个', '我不负责这个', '我不发了', '我不能给你', '我没法处理',
    '我来处理吗？', '我要发给你吗？', '我会给你回复吗？', '我来弄可以吗？', '我来处理?', '我会处理是否可以',
    '如果需要我会处理', '要是可以我来弄', '如果明天有空我会发你', '假如让我负责我会做', '我会处理，需要的话',
    '我已经发给你了', '我刚刚处理完了', '我之前负责这个', '我昨天已经回复了', '我来处理完了',
    '我会游泳', '我会开车', '我会写 Python', '我会做饭', '我会处理器编程', '我会回复功能的配置',
    '我来看看', '我来想想', '我来试试', '我试试', '我考虑一下', '我尽量', '我争取',
    '我尽量处理', '我可能会处理', '也许我会做', '我会尽量处理', '我会处理，试试看',
    '他说“我会处理”', '她说她会发', '对方说“我来弄”', '他说我会处理', '我说过我会处理',
    '"我会处理"', '「我会处理」', '> 我会处理', '引用：我会处理', '对方表示我会处理',
    '他说：\n我会处理', '对方：\n我会处理', '原文：\n我来处理',
    `他说：${'这次讨论涉及很多内容，'.repeat(6)}\n我会处理这个问题`,
    `对方提到：${'记录里还有许多背景说明。'.repeat(6)}\n我来处理`,
    '晚点发你', '之后处理', '到时候给你', '明天发你', '到时候处理', '晚点联系',
    '我会的', '我来', '我负责', '我负责这个', '我会发', '我会把文件',
    '这个可以', '到时候再说', '回头看看', '再联系', '这个我处理', '我们会处理',
    '你让我来处理', '他会处理', '我会让他处理', '我来安排他处理',
    '我会处理这个问题。但是我没时间。', '如果需要。\n我会处理这个问题', '', '   '
  ])('负例或模糊表达保守跳过：%s', body => {
    expect(matchCommitmentBody(body)).toBeNull()
  })
  it('固定版本、规则标识、解释代码和顺序稳定；多规则命中仅返回优先结果', () => {
    expect(COMMITMENT_RULE_VERSION).toBe('commitment-v1')
    expect(COMMITMENT_RULE_IDS).toEqual(['self_responsibility', 'self_future_action', 'self_will_action', 'self_take_action'])
    expect(new Set(COMMITMENT_RULE_IDS).size).toBe(4)
    expect(Object.isFrozen(COMMITMENT_RULE_IDS)).toBe(true)
    const body = '我来处理，我会回复你，这块我负责，我稍后回复你'
    const result = matchCommitmentBody(body)
    expect(result?.rule_id).toBe('self_responsibility')
    for (let index = 0; index < 20; index++) expect(matchCommitmentBody(body)).toEqual(result)
  })
  it('只做规范组合和首尾空白处理；不折叠兼容字符、不猜主语、不转换后续线索为日期', () => {
    expect(matchCommitmentBody('  我会处理这个问题。\n')).toEqual(matchCommitmentBody('我会处理这个问题'))
    expect(matchCommitmentBody('我稍后回复你 e\u0301')).toEqual(matchCommitmentBody('我稍后回复你 é'))
    expect(matchCommitmentBody('我會處理這個問題')).toBeNull()
    expect(matchCommitmentBody('我 会处理')).toBeNull()
    expect(matchCommitmentBody(null as unknown as string)).toBeNull()
    expect(matchCommitmentBody('我晚点给你发')).toEqual({ rule_id: 'self_future_action',
      reason_code: 'explicit_self_future_action', rule_version: COMMITMENT_RULE_VERSION })
  })
  it('数百来源正文的有限固定匹配开销保持轻量', () => {
    const corpus = ['我会把文件发给你', '我稍后回复你', '如果需要我会处理', '他说“我会处理”', '这个部分我负责', '晚点发你']
    const started = performance.now()
    const results = Array.from({ length: 600 }, (_, index) => matchCommitmentBody(corpus[index % corpus.length]))
    const elapsed = performance.now() - started
    expect(results.filter(Boolean)).toHaveLength(300)
    // 宽松上限只拦截明显失控；实际量级随测试输出报告，不作为产品延迟承诺。
    expect(elapsed).toBeLessThan(1000)
    console.info(`承诺匹配轻量验证：600 条正文，${elapsed.toFixed(2)} 毫秒`)
  })
})
