import type { DailyValue, ImportanceLevel } from '../../src/shared/models'

/**
 * 本替换版本的正文均为从零构造的 synthetic test data。
 * 不来源于真实聊天、人工脱敏聊天或真实用户资料；不描述被替换版本的来源。
 * ID、标签、优先级与固定回归子集沿用本历史版本的测试契约。
 */
export interface DailyValueLabelFixture {
  sampleId: string
  text: string
  selectedByD1: boolean
  humanLabel: DailyValue
  desiredPriority: ImportanceLevel
}

export const DAILY_VALUE_LABEL_FIXTURES: DailyValueLabelFixture[] = [
  { sampleId: 'DV-001', text: 'https://synthetic.invalid/atlas', selectedByD1: true, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-002', text: '[图片] synthetic_mosaic_001.jpg', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-003', text: '纸鹤往左转还是往右转？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-004', text: '虚构回声盒的校验服务无法读取积木纹样。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-005', text: '圆形拼片暂放这一页。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-006', text: '合成角色丁选哪颗棋子？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-007', text: '给纸蜻蜓留个空位。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-008', text: '求购虚构拼图用的月牙卡片。', selectedByD1: true, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-009', text: '合成货架出售星纹纸片，限沙盘演练。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-010', text: '虚构绘本的装订材料供给清单。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-011', text: '方框里填的是几何图吗？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-012', text: '沙盘绘具采购：六角画板。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-013', text: '折纸绵羊排到后面。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-014', text: '虚构拼装站公告：公共积木轨道存在脱落风险，请及时处理松动接头，保持通道畅通。', selectedByD1: true, humanLabel: 'must_show', desiredPriority: 'high' },
  { sampleId: 'DV-015', text: '纸鲸朝哪边游呢？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-016', text: '我挑圆点那一面。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-017', text: '合成团队的纹样数据只存在沙盘内，系统限制导出彩色层。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'medium' },
  { sampleId: 'DV-018', text: '棋盘边缘是银色的吗？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-019', text: '先摆完这圈积木再聊。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-020', text: '虚构星图的纸舟应该朝哪个方向？', selectedByD1: true, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-021', text: '谁挑了三角形那张？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-022', text: '合成卡片资料的采购需求：空白格须留作涂鸦。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-023', text: '下一轮轮到谁呀？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-024', text: '先歇一小会儿。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-025', text: '🧩', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-026', text: '纸风筝挪到角落。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-027', text: '虚构沙盘的计费记录异常，标记额度被扣除。', selectedByD1: true, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-028', text: '虚构折页工具发布了星纹索引功能。', selectedByD1: true, humanLabel: 'must_show', desiredPriority: 'medium' },
  { sampleId: 'DV-029', text: '合成练习项目文档用于绘制纸环地图：https://github.com/example/synthetic-paper-ring', selectedByD1: true, humanLabel: 'may_show', desiredPriority: 'medium' },
  { sampleId: 'DV-030', text: '合成简报 2004年2月3日：虚构纸舟系统上线航线图；虚构棋盘工具发布配色功能。', selectedByD1: true, humanLabel: 'must_show', desiredPriority: 'high' },
  { sampleId: 'DV-031', text: 'https://synthetic.invalid/workshop', selectedByD1: true, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-032', text: '虚构纹样知识库适合查找几何拼片的练习步骤。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'medium' },
  { sampleId: 'DV-033', text: '合成角色戊把哪页折起来了？', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-034', text: '我在虚构纸环服务看到故障，刻度盘没有反应。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-035', text: 'qyx+zpt v8.6 demo', selectedByD1: true, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-036', text: '[图片] synthetic_lantern_002.jpg', selectedByD1: true, humanLabel: 'drop', desiredPriority: 'low' },
  { sampleId: 'DV-037', text: '虚构色块工具无法导出练习页，测试积分已经扣除。', selectedByD1: true, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-038', text: '虚构道具柜的销售联系人在哪里？', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'low' },
  { sampleId: 'DV-039', text: '合成纸艺展招聘布景服务商，仅供沙盘排演。', selectedByD1: false, humanLabel: 'may_show', desiredPriority: 'medium' },
  { sampleId: 'DV-040', text: '虚构纸鲸停在圆点的旁边。', selectedByD1: false, humanLabel: 'drop', desiredPriority: 'low' }
]
