import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openDatabase } from '../../database'
import { createWorkBuddyMcpServer } from './tool'
import { markConnectorHeartbeat } from '../../first-use'

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

function resolveDatabasePath(): string {
  const direct = argumentValue('--database') ?? process.env.PRIVATE_RADAR_MCP_DATABASE
  if (direct) return resolve(direct)
  const defaultDataDir = process.env.APPDATA ? join(process.env.APPDATA, 'private-radar') : 'runtime-data/workbuddy'
  const dataDir = argumentValue('--data-dir') ?? process.env.PRIVATE_RADAR_DATA_DIR ?? defaultDataDir
  return join(resolve(dataDir), 'private-radar.db')
}

function createLifecycleLogger(databasePath: string): (event: string, detail?: string) => void {
  const logPath = resolve(argumentValue('--log-path') ?? process.env.PRIVATE_RADAR_MCP_LOG_PATH ?? join(dirname(databasePath), 'logs', 'workbuddy-connector.log'))
  mkdirSync(dirname(logPath), { recursive: true })
  return (event: string, detail?: string): void => {
    try {
      const suffix = detail ? ` ${detail.replace(/[\r\n]+/g, ' ')}` : ''
      appendFileSync(logPath, `${new Date().toISOString()} pid=${process.pid} ${event}${suffix}\n`, 'utf8')
    } catch {
      // 日志失败不得污染 stdout，也不得影响 MCP 连接。
    }
  }
}

async function main(): Promise<void> {
  const databasePath = resolveDatabasePath()
  const log = createLifecycleLogger(databasePath)
  log('PROCESS_START', `node=${process.version} database=${databasePath}`)
  mkdirSync(dirname(databasePath), { recursive: true })
  const db = openDatabase(databasePath)
  log('DATABASE_OPENED')
  markConnectorHeartbeat(db, 'connected')
  const heartbeat = setInterval(() => markConnectorHeartbeat(db, 'connected'), 15_000)

  const handle = serveStdio(() => {
    log('SERVER_INSTANCE_CREATED')
    return createWorkBuddyMcpServer(db, log, { databasePath })
  }, {
    legacy: 'serve',
    onerror: (error) => log('TRANSPORT_ERROR', error.message)
  })
  log('STDIO_LISTENING')

  let closed = false
  const close = async (reason: string): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    try {
      markConnectorHeartbeat(db, 'disconnected')
    } catch {
      // 数据库关闭前尽力记录状态。
    }
    log('SHUTDOWN_REQUESTED', reason)
    try {
      await handle.close()
    } catch (error) {
      log('TRANSPORT_CLOSE_ERROR', error instanceof Error ? error.message : '未知错误')
    }
    try {
      db.close()
    } catch (error) {
      log('DATABASE_CLOSE_ERROR', error instanceof Error ? error.message : '未知错误')
    }
    log('SHUTDOWN_COMPLETE')
  }

  process.stdin.once('end', () => log('STDIN_END'))
  process.stdin.once('close', () => log('STDIN_CLOSE'))
  process.once('SIGINT', () => void close('SIGINT').finally(() => process.exit(0)))
  process.once('SIGTERM', () => void close('SIGTERM').finally(() => process.exit(0)))
  process.once('exit', (code) => {
    try {
      db.close()
    } catch {
      // 进程退出阶段只做兜底清理。
    }
    log('PROCESS_EXIT', `code=${code}`)
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`PrivateRadar MCP 启动失败：${error instanceof Error ? error.message : '未知错误'}\n`)
  process.exitCode = 1
})
