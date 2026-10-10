import type { MenuItemConstructorOptions, OpenDialogOptions } from 'electron'

/** 桌面入口的最小平台分支，不接收渲染层提供的平台或路径策略。 */
export function manualImportDialogOptions(): OpenDialogOptions {
  return process.platform === 'darwin'
    ? { title: '选择 JSON 原始证据', properties: ['openFile'], filters: [{ name: 'JSON 原始证据', extensions: ['json'] }] }
    : { title: '选择聊天记录文件', properties: ['openFile'], filters: [{ name: '聊天记录', extensions: ['json', 'csv', 'txt'] }] }
}

export function macEditMenu(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { label: '编辑', submenu: [
      { role: 'undo', accelerator: 'Command+Z' },
      { role: 'redo', accelerator: 'Command+Shift+Z' },
      { type: 'separator' },
      { role: 'cut', accelerator: 'Command+X' },
      { role: 'copy', accelerator: 'Command+C' },
      { role: 'paste', accelerator: 'Command+V' },
      { role: 'selectAll', accelerator: 'Command+A' }
    ] }
  ]
}
