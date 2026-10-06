import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, getDashboardSummary, getTopicRadarSummary, validateDashboardDateKey } from './database'
import { importChatFile } from './import/importer'
import { getCandidateEvidence } from './intelligence/daily/repository'
import { getTopicEvidence } from './intelligence/topics/repository'
import { askChat, getMessageContext } from './retrieval/service'
import { getFirstUseStatus, markOnboardingComplete } from './first-use'
import { seedDemoData } from './demo'
import { prepareWorkBuddyConnector, runtimeDataDirectory, writeOperationalLog } from './deployment'
import { DashboardSummaryCache } from './dashboard-cache'
import { registerCollectionIpc } from './collections/desktop'
import { schedulePendingKeywordRadarRuns } from './keyword-radar/recovery'
// 主进程内部仓储入口：调用方显式传入数据库，不新增渲染层通信或公开工具。
export { listItemMessageSources, listMessageSources } from './batch-import/message-sources'
import {
  exportFeedback,
  getDailyFeedbackStates,
  getSearchFeedbackState,
  saveDailyFeedback,
  saveMissingImportantFeedback,
  saveSearchFeedback,
  type DailyFeedbackInput,
  type MissingImportantFeedbackInput,
  type SearchFeedbackInput
} from './feedback/repository'

app.setName('PrivateRadar')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const dirname = fileURLToPath(new URL('.', import.meta.url))
  const preload = join(dirname, '../preload/index.mjs')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f5f1e8',
    title: 'PrivateRadar',
    autoHideMenuBar: app.isPackaged,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (app.isPackaged) mainWindow.setMenuBarVisibility(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null)
  const dataDir = runtimeDataDirectory(app.getPath('userData'))
  const logDirectory = join(dataDir, 'logs')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(logDirectory, { recursive: true })
  writeOperationalLog(logDirectory, 'APP_STARTED')
  const existingConnectorPath = join(dataDir, 'workbuddy', 'privateradar-workbuddy')
  if (app.isPackaged && existsSync(existingConnectorPath)) {
    try {
      const payloadRoot = join(process.resourcesPath, 'workbuddy-connector')
      const deployment = prepareWorkBuddyConnector(payloadRoot, dataDir, app.getVersion())
      writeOperationalLog(logDirectory, deployment.registrationChanged
        ? 'WORKBUDDY_CONNECTOR_REGISTRATION_UPDATED'
        : 'WORKBUDDY_CONNECTOR_CONTENT_UPDATED')
    } catch (error) {
      writeOperationalLog(logDirectory, 'WORKBUDDY_CONNECTOR_AUTO_UPDATE_FAILED', error instanceof Error ? error.name : 'UNKNOWN_ERROR')
    }
  }
  const databasePath = join(dataDir, 'private-radar.db')
  const db = openDatabase(databasePath, process.env.PRIVATE_RADAR_SEED_DEMO === 'true')
  registerCollectionIpc(ipcMain, db)
  let radarDirty = false
  const summaryCache = new DashboardSummaryCache(db, databasePath, () => {
    radarDirty = true
  })

  ipcMain.handle('dashboard:get-summary', (_event, requestedDate?: unknown) => {
    const date = validateDashboardDateKey(requestedDate)
    return date ? getDashboardSummary(db, databasePath, false, false, date) : summaryCache.get()
  })
  ipcMain.handle('dashboard:refresh', (_event, requestedDate?: unknown) => {
    radarDirty = true
    const date = validateDashboardDateKey(requestedDate)
    return date ? getDashboardSummary(db, databasePath, false, true, date) : summaryCache.refresh()
  })
  ipcMain.handle('dashboard:regenerate', (_event, requestedDate?: unknown) => {
    radarDirty = true
    const date = validateDashboardDateKey(requestedDate)
    return date ? getDashboardSummary(db, databasePath, true, true, date) : summaryCache.refresh(true)
  })
  ipcMain.handle('candidate:get-evidence', (_event, candidateId: string) => getCandidateEvidence(db, candidateId))
  ipcMain.handle('radar:get-summary', async () => {
    await summaryCache.get()
    const result = getTopicRadarSummary(db, radarDirty)
    radarDirty = false
    return result
  })
  ipcMain.handle('topic:get-evidence', (_event, topicId: string, date: string) => getTopicEvidence(db, topicId, date))
  ipcMain.handle('chat:ask', (_event, question: string) => askChat(db, question))
  ipcMain.handle('chat:get-context', (_event, messageId: string) => getMessageContext(db, messageId))
  ipcMain.handle('feedback:daily:states', (_event, candidateIds: string[]) => getDailyFeedbackStates(db, candidateIds))
  ipcMain.handle('feedback:daily:save', (_event, input: Omit<DailyFeedbackInput, 'appVersion'>) => saveDailyFeedback(db, { ...input, appVersion: app.getVersion() }))
  ipcMain.handle('feedback:daily:missing', (_event, input: Omit<MissingImportantFeedbackInput, 'appVersion'>) => saveMissingImportantFeedback(db, { ...input, appVersion: app.getVersion() }))
  ipcMain.handle('feedback:search:state', (_event, question: string, sourceMessageIds: string[]) => getSearchFeedbackState(db, question, sourceMessageIds))
  ipcMain.handle('feedback:search:save', (_event, input: Omit<SearchFeedbackInput, 'appVersion'>) => saveSearchFeedback(db, { ...input, appVersion: app.getVersion() }))
  ipcMain.handle('feedback:export', async () => {
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      buttons: ['继续导出', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '导出测试反馈',
      message: '反馈文件可能包含你标记过的聊天片段，仅会保存到你选择的本地位置。'
    })
    if (confirmation.response !== 0) return { cancelled: true, path: null, count: 0 }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '保存测试反馈',
      defaultPath: join(dataDir, `PrivateRadar-feedback-${stamp}.json`),
      filters: [{ name: '反馈文件', extensions: ['json'] }]
    })
    if (selection.canceled || !selection.filePath) return { cancelled: true, path: null, count: 0 }
    const count = exportFeedback(db, selection.filePath)
    writeOperationalLog(logDirectory, 'FEEDBACK_EXPORTED', `count=${count}`)
    return { cancelled: false, path: selection.filePath, count }
  })
  ipcMain.handle('experience:get-status', () => getFirstUseStatus(db, databasePath, new Date(), app.getVersion()))
  ipcMain.handle('experience:activate-demo', () => {
    seedDemoData(db)
    markOnboardingComplete(db)
    radarDirty = true
    return summaryCache.refresh()
  })
  ipcMain.handle('experience:open-workbuddy-config', async () => {
    try {
      const payloadRoot = app.isPackaged
        ? join(process.resourcesPath, 'workbuddy-connector')
        : join(app.getAppPath(), 'integrations', 'workbuddy', 'connector')
      const result = prepareWorkBuddyConnector(payloadRoot, dataDir, app.getVersion())
      writeOperationalLog(logDirectory, 'WORKBUDDY_CONNECTOR_REGISTERED')
      return { ...result, openError: null }
    } catch (error) {
      writeOperationalLog(logDirectory, 'WORKBUDDY_CONNECTOR_PREPARE_FAILED', error instanceof Error ? error.name : 'UNKNOWN_ERROR')
      throw error
    }
  })
  ipcMain.handle('experience:check-workbuddy', () => getFirstUseStatus(db, databasePath, new Date(), app.getVersion()))
  ipcMain.handle('settings:open-data-directory', async () => (await shell.openPath(dataDir)) || null)
  ipcMain.handle('settings:open-log-directory', async () => (await shell.openPath(logDirectory)) || null)
  ipcMain.handle('import:choose-file', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择聊天记录文件',
      properties: ['openFile'],
      filters: [{ name: '聊天记录', extensions: ['json', 'csv', 'txt'] }]
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    const result = importChatFile(db, selection.filePaths[0])
    if (result.recognizedCount > 0 && result.status !== 'failed') markOnboardingComplete(db)
    radarDirty = true
    void summaryCache.refresh()
    return result
  })
  createWindow()
  schedulePendingKeywordRadarRuns(db)

  app.once('before-quit', () => {
    writeOperationalLog(logDirectory, 'APP_STOPPED')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
