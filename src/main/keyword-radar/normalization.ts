/** 与消息指纹规范化独立：保留内部空白、标点、全角字符及非 ASCII 大小写。 */
export function normalizeKeywordTermV1(term: string): string {
  const trimmed = term.trim().normalize('NFC')
  if (!trimmed) throw new Error('KEYWORD_TERM_EMPTY: 关键词不能为空')
  return Array.from(trimmed, character => {
    const code = character.codePointAt(0)!
    return code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : character
  }).join('')
}
