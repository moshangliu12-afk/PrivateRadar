export interface ConversationNames {
  sourceConversationName: string | null
  userConversationLabel: string | null
  displayConversationName: string
}
/** conversationName 兼容旧视图，仍代表来源事实，绝不写入用户标签。 */
export interface ConversationNameInput extends Partial<ConversationNames> {
  conversationId?: string
  conversationName?: string | null
}
export function resolveDisplayConversationName(value: ConversationNameInput): string {
  const source = value.sourceConversationName === undefined ? value.conversationName : value.sourceConversationName
  return value.userConversationLabel?.trim() || source?.trim() || '未知会话'
}
export interface ConversationLabelView extends ConversationNames { conversationId: string }
export type ConversationLabelResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface ConversationLabelApi {
  listConversations: () => Promise<ConversationLabelResult<ConversationLabelView[]>>
  setConversationLabel: (conversationId: string, label: string | null) => Promise<ConversationLabelResult<ConversationLabelView>>
}
