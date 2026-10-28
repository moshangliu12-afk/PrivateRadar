import type { DatabaseSync } from 'node:sqlite'
import { resolveDisplayConversationName } from '../shared/conversation-labels'
import type { ConversationLabelView, ConversationLabelResult, ConversationNameInput, ConversationNames } from '../shared/conversation-labels'

interface ConversationRow { id: string; name: string; user_conversation_label: string | null }
function names(row: ConversationRow): ConversationLabelView {
  const sourceConversationName = row.name?.trim() ? row.name : null
  const value = { conversationId: row.id, sourceConversationName, userConversationLabel: row.user_conversation_label }
  return { ...value, displayConversationName: resolveDisplayConversationName(value) }
}
export function listConversations(db: DatabaseSync): ConversationLabelView[] {
  return (db.prepare('SELECT id,name,user_conversation_label FROM conversations ORDER BY id').all() as unknown as ConversationRow[]).map(names)
}
/** 展示时读取当前名称，不修改消息、来源快照或派生算法缓存。 */
export function conversationNameProjector(db: DatabaseSync) {
  const current = new Map(listConversations(db).map(value => [value.conversationId, value]))
  return <T extends ConversationNameInput>(value: T): T & ConversationNames => {
    const known = current.get(value.conversationId ?? '')
    const source = value.sourceConversationName === undefined ? value.conversationName : value.sourceConversationName
    const fields = known ?? { sourceConversationName: source?.trim() ? source : null, userConversationLabel: value.userConversationLabel ?? null }
    return { ...value, ...fields, displayConversationName: resolveDisplayConversationName(fields) }
  }
}
export function setConversationLabel(db: DatabaseSync, conversationId: unknown, label: unknown): ConversationLabelView {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) throw new Error('会话编号无效，请刷新后重试。')
  if (label !== null && typeof label !== 'string') throw new Error('请输入会话名称。')
  const normalized = typeof label === 'string' ? label.trim() : ''
  if (normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('名称须为不超过 120 字的单行文字。')
  const changed = db.prepare('UPDATE conversations SET user_conversation_label=? WHERE id=?').run(normalized || null, conversationId)
  if (changed.changes !== 1) throw new Error('会话已不存在，请刷新后重试。')
  return names(db.prepare('SELECT id,name,user_conversation_label FROM conversations WHERE id=?').get(conversationId) as unknown as ConversationRow)
}
interface IpcRegistrar { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
export function registerConversationLabelIpc(ipc: IpcRegistrar, db: DatabaseSync): void {
  const safe = <T>(action: () => T): ConversationLabelResult<T> => {
    try { return { ok: true, value: action() } } catch (error) {
      const allowed = ['会话编号无效，请刷新后重试。', '请输入会话名称。', '名称须为不超过 120 字的单行文字。', '会话已不存在，请刷新后重试。']
      return { ok: false, error: { message: error instanceof Error && allowed.includes(error.message) ? error.message : '会话名称保存失败，请稍后重试。' } }
    }
  }
  ipc.handle('conversation-labels:list', () => safe(() => listConversations(db)))
  ipc.handle('conversation-labels:set', (_event, id: unknown, label: unknown) => safe(() => setConversationLabel(db, id, label)))
}
