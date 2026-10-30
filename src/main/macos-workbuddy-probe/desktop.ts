import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { MacWorkBuddyProbeApi } from '../../shared/macos-workbuddy-probe'
import { probeMacWorkBuddy, type ProbeContext, type ProbeSession } from './core'

interface ProbeDesktopOptions {
  context: ProbeContext
  chooseReportPath: () => Promise<string | null>
  probe?: typeof probeMacWorkBuddy
}

/** 渲染层不能提交路径、配置或待导出的报告，报告只取主进程的最后一次结果。 */
export function registerMacWorkBuddyProbeIpc(ipc: { handle: (channel: string, handler: () => unknown) => unknown }, options: ProbeDesktopOptions): void {
  if (options.context.platform !== 'darwin') return
  let session: ProbeSession | null = null
  let running: Promise<ProbeSession> | null = null
  let saving = false
  ipc.handle('macos-workbuddy-probe:run', async () => {
    if (!running) {
      session = null
      running = (options.probe ?? probeMacWorkBuddy)(options.context)
    }
    try { session = await running; return session.report }
    finally { running = null }
  })
  ipc.handle('macos-workbuddy-probe:export', async (): ReturnType<MacWorkBuddyProbeApi['exportReport']> => {
    if (!session || running || saving) return { status: 'failed', message: '请先完成环境检测，再导出报告。' }
    saving = true
    const snapshot = session
    try {
      const chosen = await options.chooseReportPath()
      if (!chosen) return { status: 'cancelled', message: '已取消保存检测报告。' }
      if (!isAbsolute(chosen) || !chosen.endsWith('.json')) throw new Error('无效的报告位置')
      // 不跟随父目录链接，不写入探测过的 WorkBuddy 路径，不覆盖现有文件。
      const directory = dirname(resolve(chosen))
      let parent = directory
      while (dirname(parent) !== parent) {
        const stat = await fs.lstat(parent)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('保存位置含链接')
        parent = dirname(parent)
      }
      const canonical = await fs.realpath(directory)
      if (canonical.normalize('NFC') !== directory.normalize('NFC')) throw new Error('保存位置发生变化')
      for (const root of snapshot.protectedPaths) {
        const delta = relative(resolve(root), resolve(chosen))
        if (delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))) throw new Error('不可写入 WorkBuddy 目录')
      }
      const handle = await fs.open(chosen, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(JSON.stringify(snapshot.report, null, 2) + '\n'); await handle.sync() }
      finally { await handle.close() }
      return { status: 'saved', message: '检测报告已保存，请把该 JSON 文件发回。' }
    } catch {
      return { status: 'failed', message: '无法保存报告。请选择 WorkBuddy 目录以外的新文件名；无需更改系统权限。' }
    } finally { saving = false }
  })
}

export function currentProbeContext(app: { getPath: (name: 'userData') => string; getVersion: () => string; isPackaged: boolean }): ProbeContext {
  return { platform: process.platform, home: homedir(), userData: app.getPath('userData'), appVersion: app.getVersion(), isPackaged: app.isPackaged, electronVersion: process.versions.electron ?? '', nodeVersion: process.versions.node }
}
