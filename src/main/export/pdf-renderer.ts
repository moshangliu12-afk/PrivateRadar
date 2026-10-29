import { BrowserWindow, session } from 'electron'
import type { PrintToPDFOptions, Session } from 'electron'
import { createPdfHtml, assertPdfBytes, PDF_CONTENT_SECURITY_POLICY, type PdfRenderer } from './chat-pdf'
import { ExportSelectionError } from './chat-selection'

export const PDF_DOCUMENT_URL = 'https://privateradar-pdf.invalid/document'
export const PDF_PRINT_OPTIONS: PrintToPDFOptions = {
  pageSize: 'A4', landscape: false, printBackground: true, scale: 1,
  margins: { top: 0.65, bottom: 0.7, left: 0.6, right: 0.6 },
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;text-align:center;font-family:Segoe UI,sans-serif;font-size:9px;color:#66717f"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
}
let printing = false

/** 仅在专用内存会话中返回固定文档；不启动 HTTP 服务、不访问文件页面或网络资源。 */
export const renderChatPdf: PdfRenderer = async (snapshot, _appVersion, signal) => {
  const cancelled = () => new ExportSelectionError('EXPORT_CANCELLED', 'PDF 导出已取消，已有文件未覆盖。')
  if (signal?.aborted) throw cancelled()
  if (printing) throw new ExportSelectionError('EXPORT_BUSY', '已有 PDF 正在生成。')
  const html = createPdfHtml(snapshot)
  printing = true
  let window: BrowserWindow | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let isolated: Session | null = null
  let handled = false
  try {
    isolated = session.fromPartition('privateradar-pdf-v1', { cache: false })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: details.url !== PDF_DOCUMENT_URL }))
    isolated.protocol.handle('https', request => request.url === PDF_DOCUMENT_URL && request.method === 'GET'
      ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PDF_CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
      : new Response('', { status: 403 }))
    handled = true
    window = new BrowserWindow({ show: false, width: 900, height: 1200, skipTaskbar: true, focusable: false,
      webPreferences: { session: isolated, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, javascript: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, images: false, spellcheck: false, devTools: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const target = window
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(cancelled())
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new ExportSelectionError('EXPORT_IO_ERROR', 'PDF 生成超时，请缩小日期范围后重试。')), 45000)
      target.webContents.once('render-process-gone', () => reject(new ExportSelectionError('EXPORT_IO_ERROR', 'PDF 打印页面异常退出，未发布输出文件。')))
      target.once('closed', () => reject(new ExportSelectionError('EXPORT_IO_ERROR', 'PDF 打印页面已关闭，未发布输出文件。')))
      if (signal?.aborted) reject(cancelled())
    })
    return await Promise.race([interrupted, (async () => {
      await target.loadURL(PDF_DOCUMENT_URL)
      if (signal?.aborted) throw cancelled()
      const bytes = await target.webContents.printToPDF(PDF_PRINT_OPTIONS)
      if (signal?.aborted) throw cancelled()
      assertPdfBytes(bytes)
      return bytes
    })()])
  } catch (error) {
    if (error instanceof ExportSelectionError) throw error
    throw new ExportSelectionError('EXPORT_IO_ERROR', '无法生成 PDF，原数据和已有文件未被覆盖。')
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    try {
      try { if (window && !window.isDestroyed()) window.destroy() }
      finally {
        try { if (handled) isolated!.protocol.unhandle('https') }
        finally { await isolated?.clearStorageData() }
      }
    } finally { printing = false }
  }
}
