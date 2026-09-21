/** D1 与 Daily Value 共用的、只基于正文的确定性价值信号。 */
export interface DailyValueSignals {
  mediaPlaceholder: boolean
  bareLink: boolean
  hasExplicitObject: boolean
  actionRequired: boolean
  deadlineOrTimeSensitive: boolean
  consequence: boolean
  verifiableChange: boolean
  failureOrLoss: boolean
  riskOrLimitation: boolean
  alternativeCost: boolean
  broadImpact: boolean
  formalNotice: boolean
  timelyMultiEvent: boolean
  opportunity: boolean
  structuredOpportunity: boolean
  relevantResource: boolean
  unverifiedSingleReport: boolean
  questionOnly: boolean
  opaqueTokenOnly: boolean
  chatter: boolean
}

export function analyzeDailyValueSignals(value: string): DailyValueSignals {
  const text = normalize(value)
  const withoutLinks = text.replace(/https?:\/\/[^\s，。；;!?！？]+/gi, ' ').trim()
  const mediaPlaceholder = /^[［【\[](?:图片|文件|语音|视频)[］】\]](?:\s|\S)*$/u.test(text) && !hasSentenceAfterMarker(text)
  const bareLink = /^https?:\/\/[^\s]+$/i.test(text)
  const hasExplicitObject = /[A-Za-z][A-Za-z0-9 ._-]{1,}|(?:积分|额度|费用|权益|待遇|认证|聊天|记录|模型|功能|服务|系统|平台|工具|项目|数据|账号|设备|软件)|[\u4e00-\u9fff]{2,}(?:聊天|记录|待遇|认证|积分|额度|费用|权益|模型|功能|服务|系统|平台|工具|项目|数据|账号|设备|软件)/.test(withoutLinks)
  const actionRequired = /(?:请|务必|及时|需要|需|应当|必须|记得|尽快).{0,8}(?:完成|认证|处理|清理|提交|补办|报名|联系|确认|续费|更新|调整)/.test(withoutLinks) ||
    /(?:保持|维护|防范|防止|避免|清理).{0,12}(?:安全|畅通|通道|隐患|风险|整洁)/.test(withoutLinks)
  const deadlineOrTimeSensitive = /(?:截止|到期|过期|期限|最后|之前|以内|本月|本周|今日|今天|明天|到现在|一直)|\d{1,2}(?:日|号)(?:前|后|截止)?/.test(withoutLinks)
  const consequence = /(?:停发|暂停|扣除|扣了|被扣|损失|无法领取|影响|补发|失去|失效|不能使用|不好用|恢复发放)/.test(withoutLinks)
  const verifiableChange = /(?:已经|已|现已|目前|现在|刚刚|正式).{0,24}(?:换成|替换为|改为|切换为|迁移到|转到|新增|支持|开放|上线|发布|更新|完成)|(?:发布|更新|上线|推出|新增|修复).{0,18}(?:功能|能力|模型|配置|服务|系统|版本)/.test(withoutLinks)
  const failure = /(?:无法|不能|失败|出错|异常|连不上|中断|崩溃|生成不出来|生不出来|做不出来|没办法|没有反应|不可用)/.test(withoutLinks)
  const loss = /(?:扣费|扣了|被扣|扣除|积分|额度|费用|金额|钱|待遇|权益|补发)/.test(withoutLinks)
  const failureOrLoss = failure && loss
  const riskOrLimitation = /(?:风险|隐患|故障|异常|无法|不能|连不上|中断|安全|漏洞|限制|兼容|依赖|失效|不稳定|不好用|不能用|无法使用|不一定能看到|没办法|扣费|可能.{0,12}(?:不好用|失效|不能用|不可用)|改(?:动|了).{0,18}(?:不好用|失效|不能用|不可用))/.test(withoutLinks)
  const alternativeCost = /(?:手动|替代|改用).{0,14}(?:麻烦|成本|问题|无法|不能|不便)/.test(withoutLinks)
  const formalNotice = /(?:通知|公告|温馨提示|服务中心|管理规定|各位(?:业主|住户|用户|客户)|尊敬的)/.test(withoutLinks)
  const broadImpact = /(?:全体|各位|多个|所有)(?:用户|客户)|(?:业主|住户|团队|公共|小区|行业|多项|多个|大家)/.test(withoutLinks)
  const hasDateOrTimeliness = /(?:今天|今日|本周|\d{4}[年\/-]\d{1,2}|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})/.test(withoutLinks)
  const eventCount = (withoutLinks.match(/发布|更新|上线|推出|完成|融资|测试|修复|呼吁|警示/g) ?? []).length
  const numberedEvents = (withoutLinks.match(/(?:^|\s)\d+[.、]/g) ?? []).length
  const timelyMultiEvent = hasDateOrTimeliness && (eventCount >= 2 || numberedEvents >= 2) && hasExplicitObject
  const opportunity = /(?:求购|采购|货源|渠道|供给|出售|出(?:[一二三四五六七八九十\d]+)?(?:张|个|份|家)|合作|招聘|申报|服务商|销售|联系人|对接|需要.*(?:品牌|服务商|资料|联系人))/.test(withoutLinks)
  const structuredOpportunity = opportunity && /(?:申报|招聘|合作|服务商|品牌年度|明确截止)/.test(withoutLinks) && withoutLinks.length >= 14
  const resourceSignal = /(?:项目|工具|仓库|教程|课程|文档|资料|知识库|资源|下载)/.test(withoutLinks)
  const purposeSignal = /(?:可以|能够|用于|适合|帮助|维护|推荐|试一下|看看|用来)/.test(withoutLinks)
  const relevantResource = resourceSignal && purposeSignal && withoutLinks.length >= 14
  const unverifiedSingleReport = /(?:好像|感觉|我看|我用|我在|我刚|又|可能|不一定)/.test(withoutLinks) || (!broadImpact && /(?:我|你)/.test(withoutLinks))
  const changeOrRisk = verifiableChange || failureOrLoss || riskOrLimitation
  const questionOnly = isQuestion(text) && !changeOrRisk && !opportunity && !relevantResource
  const opaqueTokenOnly = withoutLinks.length <= 26 && !hasSentenceVerb(withoutLinks) && /[A-Za-z]/.test(withoutLinks) && /\d|\b[A-Za-z]{2,}\b/.test(withoutLinks)
  const chatter = withoutLinks.length <= 18 && !changeOrRisk && !opportunity && !relevantResource && !hasExplicitObject
  return {
    mediaPlaceholder, bareLink, hasExplicitObject, actionRequired, deadlineOrTimeSensitive,
    consequence, verifiableChange, failureOrLoss, riskOrLimitation, alternativeCost,
    broadImpact, formalNotice, timelyMultiEvent, opportunity, structuredOpportunity,
    relevantResource, unverifiedSingleReport, questionOnly, opaqueTokenOnly, chatter
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function hasSentenceAfterMarker(text: string): boolean {
  const remainder = text.replace(/^[［【\[](?:图片|文件|语音|视频)[］】\]]/u, '').trim()
  return remainder.length > 0 && !/^[^\s]+\.(?:jpg|jpeg|png|gif|webp|mp4|mp3|pdf|zip|rar|docx?|xlsx?|pptx?)$/i.test(remainder)
}

function hasSentenceVerb(value: string): boolean {
  return /(?:是|有|在|了|可|能|会|做|用|给|出|推|发|更|上|下|成|对|帮)/.test(value)
}

function isQuestion(value: string): boolean {
  return /[？?]|(?:吗|么|是否|有没有|能否|怎么|哪里|是不是|好不好)$/.test(value)
}
