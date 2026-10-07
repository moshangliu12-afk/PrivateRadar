/** 固定规则版本只在此定义；变更规则语义时必须另立版本，不动态生成。 */
export const COMMITMENT_RULE_VERSION = 'commitment-v1' as const

export interface CommitmentMatch {
  rule_id: string
  reason_code: string
  rule_version: typeof COMMITMENT_RULE_VERSION
}

const action = /^(?:处理|确认|整理|回复|联系|修改|提交|补充|核对)/u
const actionNouns = /^(?:处理器|确认键|回复功能|联系人|修改器|提交记录|核对码)/u
const transfer = /^(?:把[^，,。.!！；;\r\n]{1,80}发(?:送)?(?:给)?(?:你|您|他|她)|给(?:你|您|他|她)(?:发(?:送)?|提供)|发(?:送)?(?:给)?(?:你|您|他|她)|提供(?:资料|文件|文档|报告|清单|方案))/u
function explicitAction(body: string): boolean {
  return (action.test(body) && !actionNouns.test(body)) || transfer.test(body)
}
const responsibilityObject = '(?:这个部分|这部分|这块|这个问题|这个模块|这个项目|这项任务|这件事|这项工作|这个需求|后端修改|前端修改|资料整理|文件整理|接口修改|测试核对)'
const selfResponsibility = new RegExp(`^我负责${responsibilityObject}$`, 'u')
const objectResponsibility = new RegExp(`^${responsibilityObject}我负责(.*)$`, 'u')

// 任一分句存在这些线索时整条跳过，避免用另一分句补齐或猜测当前发言者的意图。
const conservativeFilters = [
  /不|没|无法|取消|拒绝|别(?:让|再)/u,
  /[?？]|吗|么|呢|是否|能否|可否|(?:可以|行|好|对)(?:不|吧)/u,
  /如果|要是|假如|假设|倘若|只要|只有|除非|的话|看情况|视情况|有空/u,
  /已经|刚刚|刚才|之前|昨天|曾经|上次|先前|(?:过|了)[。.!！\s]*$/u,
  /擅长|熟悉|学会|掌握|能力|技能|经验/u,
  /可能|也许|大概|或许|尽量|争取|试试|尝试|考虑|看看|想想|打算|希望|计划|愿意|有机会|试着/u,
  /[“”‘’"'「」『』«»]|(?:^|\n)\s*>|引用|转述|原话|(?:对方|原文|转发内容)[:：]|说|表示|声称|提到/u
] as const

// 固定优先级：明确责任、明确后续行动、明确会做、明确接手；同一来源只返回一个结果。
const rules = [
  { rule_id: 'self_responsibility', reason_code: 'explicit_self_responsibility', matches: (clause: string) => {
    if (selfResponsibility.test(clause)) return true
    const reversed = objectResponsibility.exec(clause)
    if (reversed) return reversed[1] === '' || explicitAction(reversed[1])
    return clause.startsWith('我负责') && explicitAction(clause.slice(3))
  } },
  { rule_id: 'self_future_action', reason_code: 'explicit_self_future_action', matches: (clause: string) => {
    const match = /^我(?:会)?(?:晚点|等会儿?|稍后|之后)(?:会)?(.+)$/u.exec(clause)
    return Boolean(match && explicitAction(match[1]))
  } },
  { rule_id: 'self_will_action', reason_code: 'explicit_self_will_action', matches: (clause: string) =>
    clause.startsWith('我会') && explicitAction(clause.slice(2)) },
  { rule_id: 'self_take_action', reason_code: 'explicit_self_take_action', matches: (clause: string) =>
    clause.startsWith('我来') && explicitAction(clause.slice(2)) }
] as const
export const COMMITMENT_RULE_IDS: readonly string[] = Object.freeze(rules.map(rule => rule.rule_id))

/** 只读单个来源正文，保守拒绝不确定表达；不读取上下文、元数据、证据或外部服务。 */
export function matchCommitmentBody(body: string): CommitmentMatch | null {
  if (typeof body !== 'string') return null
  const text = body.normalize('NFC').trim()
  if (!text || conservativeFilters.some(filter => filter.test(text))) return null
  const clauses = text.split(/[，,。.!！；;\r\n]/u).map(clause => clause.trim()).filter(Boolean)
  for (const rule of rules) {
    if (clauses.some(clause => rule.matches(clause))) {
      return { rule_id: rule.rule_id, reason_code: rule.reason_code, rule_version: COMMITMENT_RULE_VERSION }
    }
  }
  return null
}
