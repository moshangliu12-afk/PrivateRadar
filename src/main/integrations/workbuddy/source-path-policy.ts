import { lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { win32 as path } from 'node:path'
import { safeAbsolutePath } from '../../batch-import/windows-path-lease'

export type WorkBuddyPathFailureCode = 'ROOT_COMPONENT_INVALID' | 'PATH_TRAVERSAL_DETECTED'
  | 'REPARSE_POINT_DETECTED' | 'FINAL_PATH_MISMATCH' | 'FINAL_PATH_REPRESENTATION_MISMATCH'
  | 'CASE_ALIAS_MISMATCH' | 'UNICODE_NORMALIZATION_MISMATCH'
  | 'ROOT_REPARSE_UNRESOLVABLE' | 'ROOT_REPARSE_UNSUPPORTED' | 'ROOT_CANONICAL_CHANGED'
  | 'DESCENDANT_REPARSE_REJECTED' | 'CANONICAL_OUTSIDE_ROOT' | 'RELATIVE_STRUCTURE_MISMATCH'
  | 'PREFIX_COLLISION' | 'INVALID_USER_ID' | 'INVALID_WCH_DIR'

export class WorkBuddyPathValidationError extends Error {
  constructor(readonly code: WorkBuddyPathFailureCode, message: string, detail = '') {
    super(`[${code}] ${message}${detail ? `；${detail}` : ''}`)
    this.name = 'WorkBuddyPathValidationError'
  }
}

/** 仅统一最终路径的显示形式；不得用于放行原始设备路径或改变安全判定。 */
export function normalizeWorkBuddyFinalPathDisplay(value: string): string {
  const dos = value.replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, '').replaceAll('/', '\\')
  return dos.length > 3 ? dos.replace(/\\+$/, '') : dos
}

export function classifyWorkBuddyPathMismatch(expected: string, actual: string): WorkBuddyPathFailureCode {
  const left = normalizeWorkBuddyFinalPathDisplay(expected), right = normalizeWorkBuddyFinalPathDisplay(actual)
  if (left === right) return 'FINAL_PATH_REPRESENTATION_MISMATCH'
  if (left.toLowerCase() === right.toLowerCase()) return 'CASE_ALIAS_MISMATCH'
  if (left.normalize('NFC') === right.normalize('NFC')) return 'UNICODE_NORMALIZATION_MISMATCH'
  // 出现波浪号不足以证明 8.3 别名；没有长名或句柄证据时保留为最终路径差异。
  return 'FINAL_PATH_MISMATCH'
}

/** 仅在既有安全条件已经拒绝后读取元数据，不参与放行，不记录来源绝对路径。 */
export async function diagnoseWorkBuddyPathMismatch(
  expected: string, actual: string, anchor: string, target: string
): Promise<WorkBuddyPathValidationError> {
  const code = classifyWorkBuddyPathMismatch(expected, actual)
  if (code !== 'FINAL_PATH_MISMATCH') return new WorkBuddyPathValidationError(code, '来源路径与最终路径不一致')
  const part = path.relative(anchor, target)
  if (!part || part === '..' || part.startsWith(`..${path.sep}`) || path.isAbsolute(part)) {
    return new WorkBuddyPathValidationError(code, '来源路径与最终路径不一致；组件诊断范围无效')
  }
  let current = anchor
  for (const [index, component] of part.split(path.sep).entries()) {
    current = path.join(current, component)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return new WorkBuddyPathValidationError('REPARSE_POINT_DETECTED', '来源路径组件是链接或目录联接', `组件序号=${index + 1}`)
      }
    } catch (error) {
      const denied = ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      return new WorkBuddyPathValidationError(code, '来源路径与最终路径不一致；尚未确认重解析组件',
        `元数据=${denied ? 'PATH_ACCESS_DENIED' : 'PATH_METADATA_UNAVAILABLE'}；组件序号=${index + 1}`)
    }
  }
  return new WorkBuddyPathValidationError(code, '来源路径与最终路径不一致；未从可读组件确认链接，需核验原生标签或长名')
}

export interface WorkBuddySourcePathPolicy {
  root: string
  /** 仅这一层允许整体迁移，其下的布局组件仍不得通过链接改向。 */
  logicalRoot: string
}

export interface TrustedWorkBuddyRoot {
  logicalRoot: string
  canonicalRoot: string
  rootIsReparsePoint: boolean
  rootReparseType: 'NONE' | 'JUNCTION' | 'SYMLINK'
  status: 'ROOT_REPARSE_ALLOWED' | 'ROOT_ORDINARY'
}

// 来源只经标准输入传递；此进程仅查询根目录元数据，不读取文件正文。
const ROOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public class WorkBuddyRootInfo {
  public string canonicalRoot, rootReparseType;
  public bool rootIsReparsePoint;
}
public static class WorkBuddyRootReader {
  [StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attributes, Tag; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out TagInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string path);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlap);
  static Exception Failed() { return new Exception("ROOT_REPARSE_UNRESOLVABLE"); }
  public static WorkBuddyRootInfo Read(string logical) {
    var result = new WorkBuddyRootInfo(); result.rootReparseType = "NONE";
    using (var link = CreateFileW(logical, 0u, 7u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero)) {
      TagInfo info;
      if (link.IsInvalid || !GetFileInformationByHandleEx(link, 9, out info, 8u) || (info.Attributes & 0x10u) == 0) throw Failed();
      result.rootIsReparsePoint = (info.Attributes & 0x400u) != 0;
      if (result.rootIsReparsePoint) {
        if (info.Tag == 0xa000000cu) result.rootReparseType = "SYMLINK";
        else if (info.Tag == 0xa0000003u) {
          // 读取标签数据只用于区分卷挂载点；绝不据此拼出可信物理路径。
          var data = new byte[16384]; uint size;
          if (!DeviceIoControl(link, 0x900a8u, IntPtr.Zero, 0u, data, (uint)data.Length, out size, IntPtr.Zero) || size < 16) throw Failed();
          int offset = BitConverter.ToUInt16(data, 8), length = BitConverter.ToUInt16(data, 10);
          if (16 + offset + length > size) throw Failed();
          string target = Encoding.Unicode.GetString(data, 16 + offset, length);
          int end = target.IndexOf('}');
          if (target.StartsWith(@"\??\Volume{", StringComparison.OrdinalIgnoreCase) && end >= 0 && target.Substring(end + 1).Trim('\\').Length == 0)
            throw new Exception("ROOT_REPARSE_UNSUPPORTED");
          result.rootReparseType = "JUNCTION";
        } else throw new Exception("ROOT_REPARSE_UNSUPPORTED");
      }
      using (var directory = CreateFileW(logical, 0u, 7u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero)) {
        TagInfo finalInfo;
        if (directory.IsInvalid || GetFileType(directory) != 1u || !GetFileInformationByHandleEx(directory, 9, out finalInfo, 8u)
          || (finalInfo.Attributes & 0x10u) == 0 || (finalInfo.Attributes & 0x400u) != 0) throw Failed();
        var name = new StringBuilder(32768);
        uint count = GetFinalPathNameByHandleW(directory, name, (uint)name.Capacity, 0u);
        if (count == 0 || count >= name.Capacity) throw Failed();
        string final = name.ToString();
        if (final.StartsWith(@"\\?\", StringComparison.Ordinal)) final = final.Substring(4);
        if (final.Length < 3 || !Char.IsLetter(final[0]) || final[1] != ':' || final[2] != '\\' || GetDriveTypeW(Path.GetPathRoot(final)) != 3u) throw Failed();
        result.canonicalRoot = final;
      }
    }
    return result;
  }
}
'@
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  $root = [WorkBuddyRootReader]::Read($request.logicalRoot)
  [Console]::WriteLine((@{ok=$true;canonicalRoot=$root.canonicalRoot;rootIsReparsePoint=$root.rootIsReparsePoint;rootReparseType=$root.rootReparseType} | ConvertTo-Json -Compress))
} catch {
  $code = if ($_.Exception.ToString().Contains('ROOT_REPARSE_UNSUPPORTED')) { 'ROOT_REPARSE_UNSUPPORTED' } else { 'ROOT_REPARSE_UNRESOLVABLE' }
  [Console]::WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
}
`

/** 每次请求重新建立可信根；不接受工具传入的根或 Junction 字符串目标。 */
export async function resolveTrustedWorkBuddyRoot(userProfile: string): Promise<TrustedWorkBuddyRoot> {
  const logicalRoot = path.join(safeAbsolutePath(userProfile), '.workbuddy')
  const failure = () => new WorkBuddyPathValidationError('ROOT_REPARSE_UNRESOLVABLE', '无法通过原生句柄解析当前用户的 WorkBuddy 数据根')
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || !systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) throw failure()
  let raw: string
  try {
    raw = await new Promise<string>((done, reject) => {
      const child = execFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ROOT_SCRIPT, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, maxBuffer: 16384, encoding: 'utf8' },
        (error, stdout) => error ? reject(failure()) : done(stdout))
      child.stdin!.on('error', () => child.kill())
      child.stdin!.end(JSON.stringify({ logicalRoot }) + '\n')
    })
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.ok !== true) {
      if (value.code === 'ROOT_REPARSE_UNSUPPORTED') throw new WorkBuddyPathValidationError('ROOT_REPARSE_UNSUPPORTED', 'WorkBuddy 根仅允许目录联接或目录符号链接')
      throw failure()
    }
    if (typeof value.canonicalRoot !== 'string' || !value.canonicalRoot
      || typeof value.rootIsReparsePoint !== 'boolean'
      || (value.rootIsReparsePoint ? !['JUNCTION', 'SYMLINK'].includes(String(value.rootReparseType)) : value.rootReparseType !== 'NONE')) throw failure()
    return { logicalRoot, canonicalRoot: safeAbsolutePath(normalizeWorkBuddyFinalPathDisplay(value.canonicalRoot)),
      rootIsReparsePoint: value.rootIsReparsePoint, rootReparseType: value.rootReparseType as TrustedWorkBuddyRoot['rootReparseType'],
      status: value.rootIsReparsePoint ? 'ROOT_REPARSE_ALLOWED' : 'ROOT_ORDINARY' }
  } catch (error) {
    if (error instanceof WorkBuddyPathValidationError) throw error
    throw failure()
  }
}

export async function assertNoWorkBuddyDescendantReparse(root: TrustedWorkBuddyRoot, sourcePath: string): Promise<void> {
  const part = path.relative(root.logicalRoot, sourcePath)
  if (!isDescendant(root.logicalRoot, sourcePath)) throw new WorkBuddyPathValidationError('CANONICAL_OUTSIDE_ROOT', '来源不在当前用户的 WorkBuddy 逻辑根内')
  let current = root.logicalRoot
  for (const component of part.split(path.sep)) {
    current = path.join(current, component)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new WorkBuddyPathValidationError('DESCENDANT_REPARSE_REJECTED', 'WorkBuddy 数据根之后不允许额外链接或目录联接')
    }
  }
}

export function assertWorkBuddyCanonicalStructure(root: TrustedWorkBuddyRoot, logical: string, canonical: string): void {
  if (!isDescendant(root.logicalRoot, logical) || !isDescendant(root.canonicalRoot, canonical)) {
    throw new WorkBuddyPathValidationError('CANONICAL_OUTSIDE_ROOT', '最终来源不在本次确认的 WorkBuddy 数据根内')
  }
  const expected = path.relative(root.logicalRoot, logical), actual = path.relative(root.canonicalRoot, canonical)
  if (expected !== actual) {
    throw new WorkBuddyPathValidationError('RELATIVE_STRUCTURE_MISMATCH', '逻辑来源与物理来源的内部相对结构不同',
      classifyWorkBuddyPathMismatch(expected, actual))
  }
}

/** 仅由当前用户主目录和本次明确路径选择根，不枚举用户或聊天目录。 */
export function workBuddySourcePathPolicy(sourcePath: string, userHome: string): WorkBuddySourcePathPolicy {
  if (!/^[A-Za-z]:[\\/]/.test(sourcePath) || /[\x00-\x1f]/.test(sourcePath)
    || sourcePath.slice(2).includes(':') || sourcePath.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    const traversal = sourcePath.split(/[\\/]/).some(part => part === '.' || part === '..')
    throw new WorkBuddyPathValidationError(traversal ? 'PATH_TRAVERSAL_DETECTED' : 'ROOT_COMPONENT_INVALID',
      '原始附件必须使用不含目录穿越的本地绝对路径')
  }
  const logicalRoot = path.resolve(userHome, '.workbuddy')
  const app = path.join(logicalRoot, 'app')
  const legacy = path.join(app, 'tmp', 'chat-history')
  const candidate = path.resolve(sourcePath)
  if (isDescendant(legacy, candidate)) return { root: legacy, logicalRoot }

  const users = path.join(app, 'users')
  const part = path.relative(users, candidate)
  const components = part.split(path.sep)
  const user = components[0]
  if ((!isDescendant(logicalRoot, candidate) && candidate.toLowerCase().startsWith(logicalRoot.toLowerCase()))
    || (!isDescendant(legacy, candidate) && candidate.toLowerCase().startsWith(legacy.toLowerCase()) && candidate !== legacy)
    || components[1]?.startsWith('wechat-chat-history-')) {
    throw new WorkBuddyPathValidationError('PREFIX_COLLISION', '来源与允许根仅有字符串前缀相同，目录边界不符')
  }
  if (components.length < 3 || /[\\/]{2}/.test(sourcePath) || !isDescendant(users, candidate)) {
    throw new WorkBuddyPathValidationError('ROOT_COMPONENT_INVALID', '原始附件路径不在允许的 WorkBuddy 聊天临时根目录内')
  }
  if (!user || user === '.' || user === '..' || /[<>:"|?*\x00-\x1f\\/]/.test(user)
    || /[. ]$/.test(user) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(user)) {
    throw new WorkBuddyPathValidationError('INVALID_USER_ID', 'WorkBuddy 用户目录必须是单个正常路径组件')
  }
  if (components[1] !== 'wechat-chat-history') throw new WorkBuddyPathValidationError('ROOT_COMPONENT_INVALID', '用户目录下必须是直接的聊天历史根')
  if (!components[2].startsWith('wch-') || components[2].length <= 4) throw new WorkBuddyPathValidationError('INVALID_WCH_DIR', '新版附件必须位于有效的 wch 目录内')
  return { root: path.join(users, user, 'wechat-chat-history'), logicalRoot }
}

function isDescendant(root: string, target: string): boolean {
  const part = path.relative(root, target)
  return !!part && part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part)
}
