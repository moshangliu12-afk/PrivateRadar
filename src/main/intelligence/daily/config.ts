export interface EntityAlias {
  key: string
  label: string
  patterns: RegExp[]
}

export interface DailyIntelligenceConfig {
  topLimit: number
  minimumScore: number
  similarityThreshold: number
  shortMessageLength: number
  exactNoise: Set<string>
  noisePatterns: RegExp[]
  highSignalPatterns: RegExp[]
  trustedDomains: Set<string>
  entityAliases: EntityAlias[]
}

export const DEFAULT_DAILY_CONFIG: DailyIntelligenceConfig = {
  topLimit: 20,
  minimumScore: 3.2,
  similarityThreshold: 0.56,
  shortMessageLength: 6,
  exactNoise: new Set([
    '哈哈', '哈哈哈', '哈哈哈哈', '收到', '好的', '好', '嗯', '哦', '谢谢', '谢谢分享',
    '辛苦了', '赞', '可以', '没问题', '早上好', '晚安', '在吗', '1', '+1', '👍', '😂', '🙏'
  ]),
  noisePatterns: [
    /^(早上|上午|中午|下午|晚上)?好[呀啊！!。]*$/,
    /^(收到|好的|谢谢|感谢|辛苦了)[，,。.!！\s]*(我晚点|稍后|回头)?(看|处理|再聊)?[一下呀啊。.!！\s]*$/,
    /^收到.{0,8}(晚一点|晚点|稍后|回头).{0,6}(看|处理)[一下呀啊。.!！\s]*$/,
    /^(中午|晚上|今天|明天).{0,8}(吃什么|吃饭|天气).{0,8}$/,
    /^(这个)?周末天气.{0,12}$/,
    /^我也遇到过类似情况[，,]?稍后再聊[。.]?$/,
    /^感谢分享[，,]?先收藏了[。.]?$/
  ],
  highSignalPatterns: [
    /https?:\/\//i,
    /github/i,
    /\bv?\d+(?:\.\d+){1,3}\b/i,
    /发布|更新|上线|开源|漏洞|截止|报名|公告|报告|教程|文档|项目|工具/i,
    /\b(?:GPT|Claude|Ollama|Gemini|OpenAI)\b/i
  ],
  trustedDomains: new Set([
    'github.com', 'docs.github.com', 'openai.com', 'anthropic.com', 'docs.anthropic.com',
    'microsoft.com', 'developer.mozilla.org', 'mp.weixin.qq.com'
  ]),
  entityAliases: [
    { key: 'claude-code', label: 'Claude Code', patterns: [/claude\s*code/i, /claude\s*编程工具/i, /anthropic\s+coding\s+agent/i] },
    { key: 'ollama', label: 'Ollama', patterns: [/\bollama\b/i] },
    { key: 'wechat-layout', label: '公众号排版工具', patterns: [/公众号.{0,6}排版工具/i] },
    { key: 'wechat-miniprogram', label: '微信小程序项目', patterns: [/微信小程序.{0,8}(项目|开源)/i] },
    { key: 'hybrid-search', label: '混合检索方案', patterns: [/(全文|关键词).{0,8}(语义|向量).{0,8}检索/i, /知识库检索方案/i] }
  ]
}
