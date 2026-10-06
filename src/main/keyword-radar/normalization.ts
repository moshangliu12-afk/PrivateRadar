/** 与消息指纹规范化独立：保留内部空白、标点、全角字符及非 ASCII 大小写。 */
export function normalizeKeywordMatchTextV1(body: string): string {
  return Array.from(body.normalize('NFC'), character => {
    const code = character.codePointAt(0)!
    return code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : character
  }).join('')
}
export function normalizeKeywordTermV1(term: string): string {
  const normalized = normalizeKeywordMatchTextV1(term.trim())
  if (!normalized) throw new Error('KEYWORD_TERM_EMPTY: 关键词不能为空')
  return normalized
}
