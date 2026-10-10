import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPage, WelcomePage } from '../src/renderer/src/App'
import type { FirstUseStatus } from '../src/shared/models'

const status: FirstUseStatus = { firstLaunch: true, demoMode: false, appVersion: '0.2.0-alpha.20',
  workBuddyConnected: false, workBuddyInstalled: false, workBuddyConnectionMessage: '尚未支持',
  connectorPrepared: false, connectorRequiresRetrust: false, databaseHealthy: true,
  totalMessageCount: 0, importBatchCount: 0, databasePath: '隔离数据库', dataDirectory: '隔离数据目录',
  logDirectory: '隔离日志目录', latestImport: null,
  dataStatus: { latestAttempt: null, lastSuccessfulImport: null, latestMessageDate: null } }
const noop = async () => {}
describe('Mac 最小入口文案与未支持集成', () => {
  it.each([true, false])('欢迎入口平台标记 %s', manualJsonOnly => {
    const html = renderToStaticMarkup(<WelcomePage error="" manualJsonOnly={manualJsonOnly} onDemo={noop} onImport={noop} onCollect={() => {}} />)
    expect(html).toContain(manualJsonOnly ? 'JSON 原始证据导入' : '导入我的微信聊天')
    expect(html.includes('开始批量收集')).toBe(!manualJsonOnly)
  })
  it.each([true, false])('设置平台标记 %s', manualJsonOnly => {
    const html = renderToStaticMarkup(<SettingsPage status={{ ...status, manualJsonOnly }} importing={false} onImportFile={noop} onConfigure={noop} onCheck={async () => status} />)
    expect(html).toContain(manualJsonOnly ? 'JSON 原始证据导入' : '从文件导入')
    expect(html.includes('配置 WorkBuddy')).toBe(!manualJsonOnly)
    expect(html.includes('检查 WorkBuddy 连接')).toBe(!manualJsonOnly)
    if (manualJsonOnly) expect(html).toContain('WorkBuddy 尚未支持')
  })
})
