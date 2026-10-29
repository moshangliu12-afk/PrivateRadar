import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderChatPdf, PDF_DOCUMENT_URL, PDF_PRINT_OPTIONS } from '../src/main/export/pdf-renderer'
import { exportFixture, cleanupExportFixtures } from './markdown-export-fixture'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'

const electron = vi.hoisted(() => ({ createWindow: vi.fn(), fromPartition: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: class { constructor(options: unknown) { return electron.createWindow(options) } },
  session: { fromPartition: electron.fromPartition }
}))
const pdf = () => Buffer.from('%PDF-1.7\n' + '测试占位'.repeat(20) + '\n%%EOF')
let isolated: any, windows: any[]
function window() {
  let destroyed = false
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(), printToPDF: vi.fn(async () => pdf())
  })
  const value = Object.assign(new EventEmitter(), {
    webContents: contents, loadURL: vi.fn(async () => undefined),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => { if (!destroyed) { destroyed = true; value.emit('closed') } })
  })
  windows.push(value)
  return value
}
beforeEach(() => {
  vi.clearAllMocks()
  windows = []
  isolated = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    protocol: { handle: vi.fn(), unhandle: vi.fn() }, clearStorageData: vi.fn(async () => undefined) }
  electron.fromPartition.mockReturnValue(isolated)
  electron.createWindow.mockImplementation(window)
})
afterEach(() => { cleanupExportFixtures(); vi.useRealTimers() })
async function snapshot() { const f = exportFixture(); f.add('消息', '<script>alert(1)</script>中文😀'); return await buildCanonicalExportSnapshot(f.databasePath, f.request) }

describe('隔离 PDF 打印页', () => {
  it('隐藏、隔离、禁脚本和 Node，内存会话只提供固定文档，阻断外部和本地资源', async () => {
    expect(await renderChatPdf(await snapshot(), '测试版本')).toEqual(pdf())
    expect(electron.fromPartition).toHaveBeenCalledExactlyOnceWith('privateradar-pdf-v1', { cache: false })
    expect(electron.createWindow.mock.calls[0][0]).toMatchObject({ show: false, skipTaskbar: true, focusable: false,
      webPreferences: { session: isolated, nodeIntegration: false, javascript: false, sandbox: true, contextIsolation: true,
        webSecurity: true, webviewTag: false, images: false, devTools: false } })
    const handler = isolated.protocol.handle.mock.calls[0][1]
    const response = await handler(new Request(PDF_DOCUMENT_URL))
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'none'")
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect((await handler(new Request(PDF_DOCUMENT_URL + '/other'))).status).toBe(403)
    const request = isolated.webRequest.onBeforeRequest.mock.calls[0][1]
    for (const url of ['https://example.invalid/', 'file:///C:/private', 'http://localhost/', 'data:text/html,attack']) {
      const callback = vi.fn(); request({ url }, callback); expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
    const callback = vi.fn(); request({ url: PDF_DOCUMENT_URL }, callback); expect(callback).toHaveBeenCalledWith({ cancel: false })
    const permission = vi.fn(); isolated.setPermissionRequestHandler.mock.calls[0][0](null, 'media', permission)
    expect(permission).toHaveBeenCalledWith(false)
    expect(isolated.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    expect(windows[0].webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(windows[0].loadURL).toHaveBeenCalledExactlyOnceWith(PDF_DOCUMENT_URL)
    expect(windows[0].webContents.printToPDF).toHaveBeenCalledExactlyOnceWith(PDF_PRINT_OPTIONS)
    expect(windows[0].destroy).toHaveBeenCalledOnce()
    expect(isolated.protocol.unhandle).toHaveBeenCalledWith('https')
    expect(isolated.clearStorageData).toHaveBeenCalledOnce()
  })
  it('A4 纵向、页边距和页码模板固定，不插入用户内容', () => {
    expect(PDF_PRINT_OPTIONS).toMatchObject({ pageSize: 'A4', landscape: false, displayHeaderFooter: true,
      margins: { top: 0.65, bottom: 0.7, left: 0.6, right: 0.6 } })
    expect(PDF_PRINT_OPTIONS.footerTemplate).toContain('pageNumber')
    expect(PDF_PRINT_OPTIONS.footerTemplate).toContain('totalPages')
    expect(PDF_PRINT_OPTIONS.footerTemplate).not.toMatch(/script|https?:|file:/)
  })
  it('调用前已取消不创建窗口', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(renderChatPdf(await snapshot(), '测试版本', controller.signal)).rejects.toThrow('EXPORT_CANCELLED')
    expect(electron.createWindow).not.toHaveBeenCalled()
  })
  it('加载中取消、并发调用拒绝、结束后仍可再次打印', async () => {
    const data = await snapshot(), controller = new AbortController()
    electron.createWindow.mockImplementationOnce(() => { const w = window(); w.loadURL.mockImplementation(() => new Promise(() => undefined)); return w })
    const first = renderChatPdf(data, '测试版本', controller.signal)
    await expect(renderChatPdf(data, '测试版本')).rejects.toThrow('EXPORT_BUSY')
    controller.abort()
    await expect(first).rejects.toThrow('EXPORT_CANCELLED')
    expect(windows[0].destroy).toHaveBeenCalledOnce()
    expect(await renderChatPdf(data, '测试版本')).toEqual(pdf())
  })
  it.each(['load', 'print', 'invalid', 'create', 'session'])('异常 %s 后关闭临时资源并释放打印状态', async failure => {
    const data = await snapshot()
    if (failure === 'session') electron.fromPartition.mockImplementationOnce(() => { throw new Error('初始化失败') })
    else if (failure === 'create') electron.createWindow.mockImplementationOnce(() => { throw new Error('创建窗口失败') })
    else electron.createWindow.mockImplementationOnce(() => {
      const w = window()
      if (failure === 'load') w.loadURL.mockRejectedValueOnce(new Error('加载失败'))
      if (failure === 'print') w.webContents.printToPDF.mockRejectedValueOnce(new Error('打印失败'))
      if (failure === 'invalid') w.webContents.printToPDF.mockResolvedValueOnce(Buffer.from('不是PDF'))
      return w
    })
    await expect(renderChatPdf(data, '测试版本')).rejects.toThrow('EXPORT_IO_ERROR')
    if (windows[0]) expect(windows[0].isDestroyed()).toBe(true)
    expect(await renderChatPdf(data, '测试版本')).toEqual(pdf())
  })
  it('打印页面异常退出时报告失败并清理', async () => {
    electron.createWindow.mockImplementationOnce(() => { const w = window(); w.loadURL.mockImplementation(async () => { w.webContents.emit('render-process-gone') }); return w })
    await expect(renderChatPdf(await snapshot(), '测试版本')).rejects.toThrow('EXPORT_IO_ERROR')
    expect(windows[0].isDestroyed()).toBe(true)
    expect(isolated.clearStorageData).toHaveBeenCalledOnce()
  })
  it('超时中止并销毁窗口，不保持永久忙状态', async () => {
    const data = await snapshot(); vi.useFakeTimers()
    electron.createWindow.mockImplementationOnce(() => { const w = window(); w.loadURL.mockImplementation(() => new Promise(() => undefined)); return w })
    const pending = renderChatPdf(data, '测试版本')
    const rejected = expect(pending).rejects.toThrow('PDF 生成超时')
    await vi.advanceTimersByTimeAsync(45000)
    await rejected
    expect(windows[0].isDestroyed()).toBe(true)
    expect(await renderChatPdf(data, '测试版本')).toEqual(pdf())
  })
})
