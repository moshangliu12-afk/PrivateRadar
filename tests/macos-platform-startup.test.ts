import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  directory: '', databases: [] as DatabaseSync[], handlers: new Map<string, (...args: unknown[]) => unknown>(),
  startup: null as Promise<unknown> | null, windows: 0,
  menu: vi.fn(), buildMenu: vi.fn((template: unknown) => template), prepare: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    setName() {}, isPackaged: true, getVersion: () => '0.2.0-alpha.20',
    getPath: () => state.directory, getAppPath: () => state.directory, once() {}, on() {},
    whenReady: () => ({ then(action: () => unknown) { state.startup = Promise.resolve().then(action); return state.startup } })
  },
  BrowserWindow: class {
    constructor() { state.windows++ }
    loadFile() { return Promise.resolve() }
    loadURL() { return Promise.resolve() }
    setMenuBarVisibility() {}
  },
  ipcMain: { handle: (name: string, action: (...args: unknown[]) => unknown) => state.handlers.set(name, action) },
  Menu: { setApplicationMenu: state.menu, buildFromTemplate: state.buildMenu },
  dialog: {}, shell: { openPath: vi.fn(async () => '') }
}))
vi.mock('../src/main/database', async original => {
  const actual = await original<typeof import('../src/main/database')>()
  return { ...actual, openDatabase: (...args: Parameters<typeof actual.openDatabase>) => {
    const db = actual.openDatabase(...args); state.databases.push(db); return db
  } }
})
vi.mock('../src/main/deployment', async original => ({
  ...await original<typeof import('../src/main/deployment')>(), prepareWorkBuddyConnector: state.prepare
}))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.unstubAllEnvs()
  for (const db of state.databases.splice(0)) if (db.isOpen) db.close()
  if (state.directory) {
    expect(dirname(resolve(state.directory))).toBe(resolve(tmpdir()))
    expect(basename(state.directory)).toMatch(/^privateradar-stage2b-startup-/)
    rmSync(state.directory, { recursive: true, force: true })
  }
})
it('Mac 真实主进程启动分支只依赖本机数据库，跳过已有 Windows 集成并拒绝配置入口', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  state.directory = mkdtempSync(join(tmpdir(), 'privateradar-stage2b-startup-'))
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: state.directory })
  mkdirSync(join(state.directory, 'workbuddy', 'privateradar-workbuddy'), { recursive: true })
  vi.stubEnv('PRIVATE_RADAR_DATA_DIR', state.directory)
  vi.stubEnv('PRIVATE_RADAR_SEED_DEMO', 'false')
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  await import('../src/main/index')
  await state.startup
  expect(state.windows).toBe(1)
  expect(state.databases[0].prepare('PRAGMA user_version').get()!.user_version).toBe(8)
  expect(state.databases[0].prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok')
  expect(state.prepare).not.toHaveBeenCalled()
  expect(state.buildMenu).toHaveBeenCalledOnce()
  expect(state.menu).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ label: '编辑' })]))
  expect(state.handlers.has('chat:ask')).toBe(true)
  expect(state.handlers.has('import:choose-file')).toBe(true)
  await expect(state.handlers.get('experience:open-workbuddy-config')!()).rejects.toThrow('尚未支持')
  expect(state.prepare).not.toHaveBeenCalled()
  expect(readdirSync(join(state.directory, 'workbuddy', 'privateradar-workbuddy'))).toEqual([])
  expect(existsSync(join(state.directory, 'workbuddy', 'privateradar-workbuddy', 'install-state.json'))).toBe(false)
})
