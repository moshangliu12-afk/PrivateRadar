import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'

// Windows 没有 Node O_NOFOLLOW；原生句柄拒绝全部重解析点，并禁止写入及删除共享。
// 路径通过标准输入传递，不作为 PowerShell 代码或命令参数插值。
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class EvidenceLease {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  static readonly Dictionary<string, SafeFileHandle> handles = new Dictionary<string, SafeFileHandle>(StringComparer.Ordinal);
  public static void Lock(string path, bool directory) {
    if (handles.ContainsKey(path)) return;
    if (GetDriveTypeW(System.IO.Path.GetPathRoot(path)) != 3u) throw new Exception("只允许本地固定磁盘");
    var handle = CreateFileW(path, directory ? 0x80u : 0x80000000u, 1u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    try {
      Info info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if ((info.Attributes & 0x400u) != 0) throw new Exception("拒绝重解析点");
      if (GetFileType(handle) != 1u || ((info.Attributes & 0x10u) != 0) != directory) throw new Exception("拒绝非普通文件或目录");
      if (!directory && info.Links != 1u) throw new Exception("拒绝多重硬链接");
      var final = new StringBuilder(32768);
      uint count = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0u);
      if (count == 0 || count >= final.Capacity) throw new Exception("无法核验句柄路径");
      string actual = final.ToString();
      if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
      if (!String.Equals(actual.TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new Exception("句柄路径不匹配");
      if (path.Length > 3 && !String.Equals(Path.GetFileName(actual.TrimEnd('\\')), Path.GetFileName(path.TrimEnd('\\')), StringComparison.Ordinal))
        throw new Exception("句柄实际文件名不匹配，拒绝大小写或 Unicode 别名混淆");
      handles.Add(path, handle);
    } catch { handle.Dispose(); throw; }
  }
  public static void Release(string root) {
    var paths = new List<string>(handles.Keys);
    foreach (string path in paths) {
      if (root == "" || String.Equals(path, root, StringComparison.Ordinal) || path.StartsWith(root + "\\", StringComparison.Ordinal)) {
        handles[path].Dispose(); handles.Remove(path);
      }
    }
  }
  static FileStream Reader(string path) {
    if (!handles.ContainsKey(path)) throw new Exception("源文件没有安全句柄");
    var borrowed = new SafeFileHandle(handles[path].DangerousGetHandle(), false);
    var stream = new FileStream(borrowed, FileAccess.Read);
    stream.Position = 0;
    return stream;
  }
  public static string Hash(string path) {
    using (var input = Reader(path)) using (var hash = SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
  }
  public static void Copy(string source, string target) {
    if (!handles.ContainsKey(Path.GetDirectoryName(target))) throw new Exception("目标父目录没有安全句柄");
    var handle = CreateFileW(target, 0x40000000u, 0u, IntPtr.Zero, 1u, 0x02200000u, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    using (handle) using (var output = new FileStream(handle, FileAccess.Write)) using (var input = Reader(source)) {
      input.CopyTo(output); output.Flush(true);
    }
  }
  public static string Read(string path, int maximum) {
    using (var input = Reader(path)) {
      if (input.Length > maximum) throw new Exception("证据文件读取容量超限");
      using (var output = new MemoryStream()) { input.CopyTo(output); return Convert.ToBase64String(output.ToArray()); }
    }
  }
}
'@
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    $value = $null
    if ($request.op -eq 'lock') { [EvidenceLease]::Lock($request.path, $request.directory) }
    elseif ($request.op -eq 'release') { [EvidenceLease]::Release($request.path) }
    elseif ($request.op -eq 'hash') { $value = [EvidenceLease]::Hash($request.path) }
    elseif ($request.op -eq 'copy') { [EvidenceLease]::Copy($request.path, $request.target) }
    elseif ($request.op -eq 'read') { $value = [EvidenceLease]::Read($request.path, $request.maximum) }
    else { throw '不支持的句柄操作' }
    [Console]::WriteLine((@{ok=$true; value=$value} | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine((@{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress))
  }
}
[EvidenceLease]::Release('')
`

export class WindowsPathLease {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }> = []
  private failure: Error | null = null
  private readonly locked = new Map<string, boolean>()
  private readonly ready: Promise<void>

  constructor() {
    if (process.platform !== 'win32') throw new Error('当前平台不支持安全目录句柄，拒绝目录证据')
    const systemRoot = process.env.SystemRoot
    if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('无法确定 Windows 系统目录')
    this.process = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'pipe' })
    this.ready = this.receive().then((value) => {
      if (value.ready !== true) throw new Error('安全目录句柄初始化失败')
    })
    void this.ready.catch(() => undefined)
    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', (line) => {
      try { this.pending.shift()?.resolve(JSON.parse(line) as Record<string, unknown>) }
      catch { this.fail(new Error('安全目录句柄响应无效')) }
    })
    let diagnostics = ''
    this.process.stderr.on('data', (value: Buffer) => { diagnostics = (diagnostics + value.toString()).slice(-2048) })
    this.process.on('error', (error) => this.fail(error))
    this.process.on('exit', () => this.fail(new Error(`安全目录句柄进程已退出：${diagnostics}`)))
    this.process.stdin.on('error', (error) => this.fail(error))
  }

  private receive(): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => this.fail(new Error('安全目录句柄响应超时')), 15000)
      this.pending.push({ resolve: (value) => { clearTimeout(timeout); resolvePromise(value) },
        reject: (error) => { clearTimeout(timeout); reject(error) } })
    })
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const request of this.pending.splice(0)) request.reject(this.failure)
    if (this.process.exitCode === null && !this.process.killed) this.process.kill()
  }

  assertHealthy(): void { if (this.failure) throw this.failure }

  private async request(value: object): Promise<Record<string, unknown>> {
    await this.ready
    this.assertHealthy()
    const response = this.receive()
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
    const result = await response
    if (result.ok !== true) throw new Error(`安全目录句柄拒绝：${String(result.error)}`)
    this.assertHealthy()
    return result
  }

  async lock(path: string, directory: boolean): Promise<void> {
    const absolute = safeAbsolutePath(path)
    const root = parse(absolute).root
    const parts = absolute.slice(root.length).split(sep).filter(Boolean)
    let parent = root
    if (!this.locked.has(root)) {
      await this.request({ op: 'lock', path: root, directory: true })
      this.locked.set(root, true)
    }
    for (let index = 0; index < parts.length; index++) {
      parent = join(parent, parts[index])
      const kind = index < parts.length - 1 || directory
      const key = parent
      if (this.locked.has(key)) {
        if (this.locked.get(key) !== kind) throw new Error('文件句柄类型冲突')
        this.assertHealthy()
      } else {
        await this.request({ op: 'lock', path: parent, directory: kind })
        this.locked.set(key, kind)
      }
    }
  }

  async releaseTree(path: string): Promise<void> {
    const absolute = safeAbsolutePath(path)
    await this.request({ op: 'release', path: absolute })
    const prefix = absolute
    for (const key of this.locked.keys()) if (key === prefix || key.startsWith(prefix + sep)) this.locked.delete(key)
  }

  async hashFile(path: string): Promise<string> {
    const result = await this.request({ op: 'hash', path: safeAbsolutePath(path) })
    if (typeof result.value !== 'string' || !/^[0-9a-f]{64}$/.test(result.value)) throw new Error('原生句柄哈希响应无效')
    return result.value
  }

  async copyFile(source: string, target: string): Promise<void> {
    await this.request({ op: 'copy', path: safeAbsolutePath(source), target: safeAbsolutePath(target) })
  }

  async readFile(path: string, maximum: number): Promise<Buffer> {
    const result = await this.request({ op: 'read', path: safeAbsolutePath(path), maximum })
    if (typeof result.value !== 'string') throw new Error('原生句柄读取响应无效')
    return Buffer.from(result.value, 'base64')
  }

  async close(): Promise<void> {
    this.process.stdin.end()
    if (this.process.exitCode !== null) return
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { this.process.kill(); done() }, 2000)
      this.process.once('exit', () => { clearTimeout(timer); done() })
    })
  }
}

export function safeAbsolutePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^[A-Za-z]:[\\/]/.test(path)
    || path.slice(2).includes(':') || /[\x00-\x1f]/.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('目录证据必须使用明确的本地绝对路径，禁止设备路径、网络路径及越界')
  }
  const absolute = resolve(path)
  for (const part of absolute.slice(3).split(sep)) {
    if (part && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error('目录证据路径包含不安全的 Windows 文件名')
    }
  }
  return absolute
}
