import { writeFileSync } from 'node:fs'

const action = process.argv[2] ?? 'inspect'
const argument = process.argv[3] ?? ''
const port = process.env.PRIVATE_RADAR_CDP_PORT ?? '9333'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('没有找到 Electron 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})
function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

if (action === 'inspect') {
  const result = await evaluate(`(() => ({
    title: document.title,
    text: document.body.innerText,
    metrics: {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  }))()`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else if (action === 'status') {
  const result = await evaluate(`window.privateRadar.getFirstUseStatus()`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else if (action === 'click') {
  const rect = await evaluate(`(() => {
    const wanted = ${JSON.stringify(argument)};
    const element = [...document.querySelectorAll('button, summary')].find((item) => item.textContent.trim().includes(wanted));
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: element.textContent.trim() };
  })()`)
  if (!rect) throw new Error(`没有找到控件：${argument}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await new Promise((resolve) => setTimeout(resolve, 800))
  process.stdout.write(`已点击：${rect.text}\n`)
} else if (action === 'fill') {
  const rect = await evaluate(`(() => {
    const element = document.querySelector('input[type="text"], input:not([type]), textarea');
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`)
  if (!rect) throw new Error('没有找到文本输入框')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await send('Input.insertText', { text: argument })
  process.stdout.write(`已输入：${argument}\n`)
} else if (action === 'screenshot') {
  await send('Page.enable')
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(argument, Buffer.from(result.data, 'base64'))
  process.stdout.write(`${argument}\n`)
} else if (action === 'close') {
  socket.send(JSON.stringify({ id: nextId++, method: 'Browser.close', params: {} }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  process.stdout.write('已关闭 Electron 窗口\n')
} else {
  throw new Error(`未知操作：${action}`)
}
socket.close()
