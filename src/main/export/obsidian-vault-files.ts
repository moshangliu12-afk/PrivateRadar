import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { ExportSelectionError } from './chat-selection'

// 复用现有目录租约锁住祖先；此辅助进程只补充 Vault 增量写入所需的文件独占与条件发布。
// 路径通过标准输入传递，不进入脚本源码；所有替换先核对被独占的原文件实际摘要。
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class VaultFiles {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr info,uint size);
  static SafeFileHandle exportLock;
  static void Check(SafeFileHandle h,string path) {
    Info i;
    if (!GetFileInformationByHandle(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (GetFileType(h)!=1 || (i.Attributes & 0x410u)!=0 || i.Links!=1) throw new Exception("拒绝非普通文件、重解析点或硬链接");
    var final=new StringBuilder(32768);
    uint size=GetFinalPathNameByHandleW(h,final,(uint)final.Capacity,0);
    if (size==0 || size>=final.Capacity) throw new Exception("无法核验最终文件路径");
    string actual=final.ToString();
    if (actual.StartsWith(@"\\?\")) actual=actual.Substring(4);
    if (!String.Equals(actual,path,StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetFileName(actual),Path.GetFileName(path),StringComparison.Ordinal)) throw new Exception("实际文件路径不匹配");
  }
  static SafeFileHandle Open(string path) {
    var h=CreateFileW(path,0x80010000u,0,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
    if (h.IsInvalid) { int code=Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(code); }
    try { Check(h,path); return h; } catch { h.Dispose(); throw; }
  }
  static string Hash(SafeFileHandle h) {
    using (var borrowed=new SafeFileHandle(h.DangerousGetHandle(),false))
    using (var input=new FileStream(borrowed,FileAccess.Read))
    using (var hash=SHA256.Create()) {
      input.Position=0;
      return BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();
    }
  }
  static void Rename(SafeFileHandle h,string target) {
    byte[] name=Encoding.Unicode.GetBytes(target);
    // 显式保留双字节终止符，避免原生路径转换读取到缓冲区后的字符。
    int root=IntPtr.Size==8?8:4, length=root+IntPtr.Size, start=length+4, size=start+name.Length+2;
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try {
      for (int i=0;i<size;i++) Marshal.WriteByte(buffer,i,0);
      Marshal.WriteIntPtr(buffer,root,IntPtr.Zero);
      Marshal.WriteInt32(buffer,length,name.Length);
      Marshal.Copy(name,0,IntPtr.Add(buffer,start),name.Length);
      if (!SetFileInformationByHandle(h,3,buffer,(uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      Check(h,target);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Acquire(string path) {
    if (exportLock!=null) throw new Exception("已经持有 Vault 写入锁");
    var h=CreateFileW(path,0xC0000000u,0,IntPtr.Zero,4,0x02200000u,IntPtr.Zero);
    if (h.IsInvalid) { int code=Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(code); }
    try { Check(h,path); exportLock=h; } catch { h.Dispose(); throw; }
  }
  public static bool Commit(string stage,string target,string stageHash,string expected,string backup) {
    if (exportLock==null) throw new Exception("尚未获得 Vault 写入锁");
    if (String.IsNullOrEmpty(expected)) expected=null;
    using (var next=Open(stage)) {
      if (Hash(next)!=stageHash) throw new Exception("临时文件摘要不匹配");
      SafeFileHandle old=null;
      try {
        try { old=Open(target); }
        catch (Win32Exception error) {
          if (error.NativeErrorCode!=2) throw;
          if (expected!=null) return false;
        }
        if (old==null) {
          try { Rename(next,target); return true; }
          catch (Win32Exception error) { if (error.NativeErrorCode==80 || error.NativeErrorCode==183) return false; throw; }
        }
        if (expected==null || Hash(old)!=expected) return false;
        // 在同一个独占句柄下把旧文件完整移入备份，再以禁止替换的方式发布新文件。
        // 中断时原始完整字节仍在备份；目标被其他进程占用时绝不覆盖。
        Rename(old,backup);
        try { Rename(next,target); }
        catch {
          try { Rename(old,target); } catch { /* 无法恢复时保留完整备份，不覆盖新占用的目标。 */ }
          throw;
        }
        return true;
      } finally { if (old!=null) old.Dispose(); }
    }
  }
  public static void Close() { if (exportLock!=null) { exportLock.Dispose(); exportLock=null; } }
}
'@
[Console]::WriteLine('{"ready":true}')
try {
  while ($null -ne ($line=[Console]::ReadLine())) {
    try {
      $r=$line | ConvertFrom-Json
      $value=$null
      if ($r.op -eq 'lock') { [VaultFiles]::Acquire($r.path) }
      elseif ($r.op -eq 'commit') {
        $expected=if($null -eq $r.expected){$null}else{[string]$r.expected}
        $value=[VaultFiles]::Commit($r.stage,$r.target,$r.hash,$expected,$r.backup)
      } else { throw '不支持的 Vault 文件操作' }
      [Console]::WriteLine((@{ok=$true;value=$value;sequence=$r.sequence} | ConvertTo-Json -Compress))
    } catch {
      [Console]::WriteLine((@{ok=$false;sequence=$r.sequence} | ConvertTo-Json -Compress))
    }
  }
} finally { [VaultFiles]::Close() }
`

export class VaultFileSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = []
  private readonly ready: Promise<void>
  private readonly exit: Promise<void>
  private failure: Error | null = null
  private sequence = 0
  private ending = false
  private exited = false
  constructor() {
    if (process.platform !== 'win32' || !process.env.SystemRoot) throw new ExportSelectionError('EXPORT_UNSUPPORTED', 'Obsidian Vault 导出仅支持 Windows 本地目录。')
    this.child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'pipe' })
    this.ready = this.receive().then(value => { if (value.ready !== true) throw new Error('Vault 文件操作初始化失败') })
    void this.ready.catch(error => this.invalidate(error))
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        const response = JSON.parse(line)
        const pending = this.pending.shift()
        if (!pending || !response || Array.isArray(response)) throw new Error('Vault 文件操作响应无效')
        pending.resolve(response)
      } catch (error) { this.invalidate(error instanceof Error ? error : new Error('Vault 文件操作响应无效')) }
    })
    this.child.stderr.resume()
    this.child.on('error', error => this.invalidate(error))
    this.child.stdin.on('error', error => this.invalidate(error))
    this.exit = new Promise(done => this.child.once('close', code => {
      this.exited = true
      if (!this.ending || code !== 0 || this.pending.length) this.invalidate(new Error('Vault 文件操作进程异常退出'))
      done()
    }))
  }
  private invalidate(error: Error): void {
    this.failure ??= error
    for (const pending of this.pending.splice(0)) pending.reject(this.failure)
    if (!this.exited && !this.child.killed) this.child.kill()
  }
  private receive(): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.invalidate(new Error('Vault 安全文件操作超时')), 20000)
      this.pending.push({ resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    })
  }
  private async request(value: object): Promise<any> {
    await this.ready
    if (this.failure || this.ending) throw this.failure ?? new Error('Vault 文件操作已经关闭')
    const sequence = ++this.sequence, response = this.receive()
    this.child.stdin.write(JSON.stringify({ ...value, sequence }) + '\n')
    const result = await response
    if (result.sequence !== sequence) {
      const error = new Error('Vault 文件操作响应编号不匹配')
      this.invalidate(error); throw error
    }
    if (result.ok !== true) throw new ExportSelectionError('EXPORT_IO_ERROR', 'Vault 文件被占用、不可写或不满足安全条件；已有完整文件和备份已保留。')
    return result.value
  }
  async lock(path: string): Promise<void> {
    try { await this.request({ op: 'lock', path }) }
    catch { throw new ExportSelectionError('EXPORT_BUSY', '此 Vault 正在导出、不可写或不满足安全条件，请关闭占用后重试。') }
  }
  async commit(stage: string, target: string, hash: string, expected: string | null, backup: string): Promise<boolean> {
    return await this.request({ op: 'commit', stage, target, hash, expected, backup })
  }
  async close(): Promise<void> {
    this.ending = true
    if (!this.exited) this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.child.kill(); reject(new Error('Vault 文件操作未正常关闭')) }, 3000)
      })])
    } finally { clearTimeout(timer) }
    if (this.failure) throw this.failure
  }
}
