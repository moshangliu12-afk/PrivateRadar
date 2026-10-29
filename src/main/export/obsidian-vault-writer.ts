import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { WindowsPathLease, safeAbsolutePath } from '../batch-import/windows-path-lease'
import { sha256 } from './chat-markdown'
import { writeComplete } from './markdown-export'
import { ExportSelectionError } from './chat-selection'
import { VaultFileSession } from './obsidian-vault-files'

export interface VaultWriteOptions {
  /** 工程测试注入，不暴露给界面或进程间通信。 */
  beforePublish?: (stage: string, target: string) => Promise<void>
  writeStagedFile?: (stage: string, bytes: Buffer) => Promise<void>
}
const inside = (parent: string, target: string) => target.toLowerCase() === parent.toLowerCase()
  || target.toLowerCase().startsWith(parent.toLowerCase().replace(/[\\/]+$/, '') + sep)
const unsafe = (message: string): never => { throw new ExportSelectionError('EXPORT_PATH_UNSAFE', message) }
export const vaultStamp = () => new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8)

export class VaultWriter {
  private readonly lease = new WindowsPathLease()
  private native: VaultFileSession | null = null
  readonly root: string
  readonly vault: string
  private constructor(vault: string, private readonly options: VaultWriteOptions) {
    this.vault = vault
    this.root = join(vault, 'PrivateRadar')
  }
  static async open(vaultPath: string, databasePath: string, options: VaultWriteOptions = {}): Promise<VaultWriter> {
    let selected: string
    try { selected = safeAbsolutePath(vaultPath) } catch { return unsafe('请选择合法的 Windows 本地 Vault 目录，禁止网络、设备或越界路径。') }
    const data = resolve(dirname(databasePath)), managed = join(selected, 'PrivateRadar')
    if (inside(data, selected) || inside(data, managed) || inside(managed, data)) unsafe('Vault 输出不能与 PrivateRadar 原数据目录重合。')
    const writer = new VaultWriter(selected, options)
    try {
      try { await writer.lease.lock(selected, true); await fs.access(selected, constants.W_OK) }
      catch { throw new ExportSelectionError('EXPORT_PATH_UNSAFE', 'Obsidian Vault 不可用，请重新选择可写的本地目录。') }
      try { await fs.mkdir(managed) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await writer.lease.lock(managed, true)
      await writer.directory('.privateradar')
      await writer.directory('.privateradar/staging')
      await writer.directory('.privateradar/backups')
      writer.native = new VaultFileSession()
      await writer.native.lock(writer.target('.privateradar/export.lock'))
      return writer
    } catch (error) {
      await writer.close()
      throw error
    }
  }
  target(relative: string): string {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) unsafe('导出相对路径无效。')
    let target: string
    try { target = safeAbsolutePath(join(this.root, ...relative.split('/'))) } catch { return unsafe('导出文件名或路径不安全。') }
    if (!inside(this.root, target) || target === this.root || target.length > 240) unsafe('导出路径越界或过长，请选择更短的 Vault 路径。')
    return target
  }
  async directory(relative: string): Promise<void> {
    const parts = relative.split('/')
    for (let n = 1; n <= parts.length; n++) {
      const target = this.target(parts.slice(0, n).join('/'))
      try { await fs.mkdir(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await this.lease.lock(target, true)
    }
  }
  async read(relative: string, maximum: number): Promise<Buffer | null> {
    const target = this.target(relative)
    try { await fs.lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      await this.lease.lock(target, false)
      return await this.lease.readFile(target, maximum)
    } finally { await this.lease.releaseTree(target) }
  }
  async fileHash(relative: string): Promise<string | null> {
    const target = this.target(relative)
    try { await fs.lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      await this.lease.lock(target, false)
      return await this.lease.hashFile(target)
    } finally { await this.lease.releaseTree(target) }
  }
  async publish(relative: string, bytes: Buffer, expected: string | null, guard: () => void, backupRelative?: string): Promise<boolean> {
    const target = this.target(relative), parent = relative.split('/').slice(0, -1).join('/')
    if (parent) await this.directory(parent)
    const stage = this.target('.privateradar/staging/' + randomUUID() + '.tmp')
    const backup = this.target(backupRelative ?? '.privateradar/backups/' + randomUUID() + (relative.endsWith('.md') ? '.md' : '.json'))
    try {
      guard(); this.lease.assertHealthy()
      await (this.options.writeStagedFile ?? writeComplete)(stage, bytes)
      await this.options.beforePublish?.(stage, target)
      guard(); this.lease.assertHealthy()
      const published = await this.native!.commit(stage, target, sha256(bytes), expected, backup)
      if (published) {
        const actual = await this.fileHash(relative)
        if (actual !== sha256(bytes)) {
          throw new ExportSelectionError('EXPORT_IO_ERROR', '发布后的完整文件校验未通过，未登记为成功。')
        }
      }
      return published
    } finally {
      try {
        const stat = await fs.lstat(stage)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await fs.unlink(stage)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  async close(): Promise<void> {
    try { if (this.native) { const native = this.native; this.native = null; await native.close() } }
    finally { await this.lease.close() }
  }
}

export async function validateObsidianVault(vault: string, databasePath: string): Promise<string> {
  const writer = await VaultWriter.open(vault, databasePath)
  try {
    const probe = '.privateradar/staging/' + randomUUID() + '.probe'
    const target = writer.target(probe)
    await writeComplete(target, Buffer.from('PrivateRadar Vault 写入检查\n', 'utf8'))
    await fs.unlink(target)
    return writer.vault
  } finally { await writer.close() }
}
