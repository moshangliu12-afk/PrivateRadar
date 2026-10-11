// 只验证隐藏窗口的预加载模块；不构成人工界面验收。
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const directory = process.env.PRIVATERADAR_CI_SMOKE_DIRECTORY
const report = process.env.PRIVATERADAR_CI_SMOKE_REPORT
assert.ok(directory); assert.ok(report)
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
app.setPath('userData', directory)
app.setPath('sessionData', directory)
app.setPath('crashDumps', directory)
const timer = setTimeout(() => { console.error('等待图形会话超时'); app.exit(2) }, 25000)
app.whenReady().then(async () => {
  const db = new DatabaseSync(join(directory, 'smoke.db'))
  try {
    db.exec("CREATE VIRTUAL TABLE smoke USING fts5(body); INSERT INTO smoke VALUES('arm64 electron')")
    assert.equal(db.prepare("SELECT count(*) AS n FROM smoke WHERE smoke MATCH 'arm64'").get().n, 1)
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { label: '编辑', submenu: [{ role: 'copy' }] }]))
    ipcMain.handle('stage2c:smoke', () => true)
    const window = new BrowserWindow({ show: false, webPreferences: {
      preload: resolve(process.env.PRIVATERADAR_CI_SMOKE_PRELOAD || 'out/preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false
    } })
    window.webContents.on('preload-error', (_event, _path, error) => { console.error(error); app.exit(1) })
    await window.loadURL('data:text/html;charset=utf-8,<html><body>隔离验收</body></html>')
    const bridge = await window.webContents.executeJavaScript('typeof window.privateRadar?.getTodayKeywordInterest === "function" && typeof window.privateRadar?.keywordRadar?.listRecentHits === "function"')
    assert.equal(bridge, true)
    writeFileSync(report, JSON.stringify({ status: 'PASS', platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, preload: 'PASS', sqlite: 'PASS', fts5: 'PASS' }, null, 2))
    window.destroy(); clearTimeout(timer); app.exit(0)
  } finally { db.close() }
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1) })
