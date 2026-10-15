#!/usr/bin/env python3
"""生成固定来源的 FFmpeg 保守源码包；仅使用 Python 标准库，不执行上游代码。"""

import argparse
import base64
import hashlib
import io
import json
import lzma
import re
import sys
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
INPUT = ROOT / 'scripts' / 'ffmpeg-source-delivery'
LIMIT = 2 * 1024 ** 3
MANIFEST = 'FFMPEG_SOURCE_PROVENANCE.json'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def git_hash(kind, value):
    return hashlib.sha1(kind.encode() + b' ' + str(len(value)).encode() + b'\0' + value).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def safe_name(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and '\\' not in name and ':' not in name
            and all(part not in {'', '.', '..'} for part in name.split('/')), '归档路径越界')
    return name


def git_tree(files, gitlinks=None):
    """按 Git 原始文件名、权限和链接内容重建树，验证完整目录没有静默缺件。"""
    root = {}
    entries = {**files}
    for name, identity in (gitlinks or {}).items():
        require(name not in entries, '子模块与文件冲突')
        entries[name] = ('160000', identity)
    for name, (mode, value) in entries.items():
        node = root
        parts = safe_name(name).split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        require(parts[-1] not in node, '源码目录项重复')
        node[parts[-1]] = (mode, value)

    def tree(node):
        result = []
        for name in sorted(node, key=lambda key: (key + ('/' if isinstance(node[key], dict) else '')).encode()):
            child = node[name]
            mode, identity = ('40000', tree(child)) if isinstance(child, dict) else (child[0], child[1] if child[0] == '160000' else git_hash('blob', child[1]))
            result.append(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(identity))
        return git_hash('tree', b''.join(result))
    return tree(root)


def read_tar(path):
    files = {}
    with tarfile.open(path, 'r:*') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/')
            if not name or member.isdir():
                continue
            safe_name(name)
            require(name not in files, '归档有重复项')
            if member.isfile():
                files[name] = ('100755' if member.mode & 0o111 else '100644', archive.extractfile(member).read())
            elif member.issym():
                # 不在本机创建或跟随符号链接，原样保留 Git 中的链接对象。
                target = member.linkname
                require(not PurePosixPath(target).is_absolute() and '\\' not in target and ':' not in target, '绝对符号链接不允许交付')
                stack = name.split('/')[:-1]
                for part in target.split('/'):
                    if part == '..':
                        require(stack, '符号链接逃出源码目录')
                        stack.pop()
                    elif part not in {'', '.'}:
                        stack.append(part)
                files[name] = ('120000', target.encode())
            else:
                raise ValueError('不支持的源码归档对象类型')
    return files


def validate_source(spec, files):
    require(git_tree(files, spec.get('gitlinks')) == spec['tree'], '源码 revision/tree 摘要不匹配：' + spec['id'])
    for name in spec['required_licenses']:
        require(name in files and files[name][0] != '120000' and files[name][1].strip(), '必需许可缺失：' + name)


def validate_origin(spec):
    require(re.fullmatch('[0-9a-f]{40}', spec['commit']), '源码 revision 格式错误')
    source = spec['source_path']
    safe_name(source) if source else None
    if spec['kind'] == 'gitiles-tree':
        expected = spec['repository'] + '/+archive/' + spec['commit'] + ('/' + source if source else '') + '.tar.gz'
    elif spec['repository'].startswith('https://github.com/'):
        expected = spec['repository'].replace('https://github.com/', 'https://raw.githubusercontent.com/') + '/' + spec['commit'] + '/' + source
    else:
        expected = spec['repository'] + '/+/' + spec['commit'] + '/' + source + '?format=TEXT'
    require(spec['url'] == expected, '源码 revision 与固定下载地址不一致')
    require(spec['repository'].startswith(('https://chromium.googlesource.com/', 'https://github.com/electron/')), '非授权官方来源')
    require(re.fullmatch('[0-9a-f]{64}', spec['download_sha256']), '来源 SHA-256 缺失')
    require(Path(spec['cache_file']).name == spec['cache_file'], '缓存文件名越界')
    safe_name(spec['target'])


def fetch(spec, cache, download):
    validate_origin(spec)
    path = cache / spec['cache_file']
    require(not path.is_symlink(), '缓存不能是符号链接')
    if not path.exists():
        require(download, '缺少固定源码：' + spec['id'])
        with urllib.request.urlopen(spec['url'], timeout=180) as response:
            value = response.read()
        if spec['kind'] == 'blob' and spec['repository'].startswith('https://chromium.googlesource.com/'):
            value = base64.b64decode(value, validate=False)
        require(digest(value) == spec['download_sha256'], '下载摘要不匹配：' + spec['id'])
        path.write_bytes(value)
    require(path.is_file() and not path.is_symlink(), '缓存不是普通文件')
    value = path.read_bytes()
    require(digest(value) == spec['download_sha256'], '缓存摘要不匹配：' + spec['id'])
    return path, value


def add(files, path, value, mode='100644'):
    safe_name(path)
    require(path not in files, '交付路径重复：' + path)
    files[path] = (mode, value)


def inventory(files):
    return [{'path': name, 'git_mode': mode, 'bytes': len(value), 'sha256': digest(value), 'git_blob_sha': git_hash('blob', value)}
            for name, (mode, value) in sorted(files.items())]


def validate_project(metadata):
    require(read_json(ROOT / 'package.json')['version'] == metadata['privateradar']['version'], '项目版本改变，须重新审核交付身份')
    locked = read_json(ROOT / 'package-lock.json')['packages']['node_modules/electron']['version']
    require(locked == metadata['electron']['version'], '锁定 Electron 版本与来源清单不一致')


def collect(cache, download=False):
    lock = read_json(INPUT / 'sources.lock.json')
    require(lock['schema_version'] == 1 and lock['strategy'] == 'conservative_superset', '来源锁格式不匹配')
    files = {}
    trees = []
    for spec in lock['snapshots']:
        path, _ = fetch(spec, cache, download)
        source = read_tar(path)
        validate_source(spec, source)
        for name, (mode, value) in source.items():
            add(files, spec['target'] + '/' + name, value, mode)
        trees.append({**spec, 'files': len(source), 'verification': 'git_tree_and_sha256'})
        print('已核验固定源码：' + spec['id'], flush=True)
    for spec in lock['blobs']:
        _, value = fetch(spec, cache, download)
        require(git_hash('blob', value) == spec['blob'], 'Git blob 不匹配：' + spec['id'])
        add(files, spec['target'], value, spec.get('mode', '100644'))
    metadata = read_json(INPUT / 'provenance-inputs.json')
    require(metadata['schema_version'] == 1, '交付元数据格式不匹配')
    validate_project(metadata)
    for platform, receipt in metadata['effective_gn_args']['original_receipts'].items():
        name = 'build-receipts/' + platform + '/args.gn'
        value = (INPUT / name).read_bytes()
        require(digest(value) == receipt['sha256'], '原始 args.gn 摘要不匹配')
        add(files, name, value)
    configs = read_json(INPUT / 'platform-configs.json')
    require(len(configs) == 22, '平台配置清单不等于 22 项')
    for config in configs:
        value = files[config['name']][1]
        require(digest(value) == config['sha256'] and git_hash('blob', value) == config['git_blob_sha'], '平台配置摘要不匹配')
    for platform in ['win/x64', 'mac/arm64']:
        config = files['ffmpeg/chromium/config/Chrome/' + platform + '/config.h'][1].decode()
        for flag in ['GPL', 'GPLV3', 'NONFREE', 'VERSION3', 'LIBX264', 'LIBX265', 'LIBFDK_AAC']:
            require(re.search(r'^#define CONFIG_' + flag + r' 0$', config, re.M), '发布配置许可标志冲突')
        require('#define CONFIG_LIBOPUS 1' in config, '发布配置缺少 Opus')
    patch = 'electron-ffmpeg-patches/link_with_loader_path.patch'
    require(digest(files[patch][1]) == metadata['patches']['ffmpeg'][0]['sha256'], 'Electron FFmpeg 补丁身份不匹配')
    require(files['electron-ffmpeg-patches/.patches'][1].decode().splitlines() == ['link_with_loader_path.patch'], 'FFmpeg 补丁队列改变')
    for name in ['BUILD_RECEIPT_LIMITATIONS.md', 'README.md', 'toolchain/windows-system-libraries.json']:
        add(files, name, (INPUT / name).read_bytes())
    add(files, 'FFmpeg-LGPL-NOTICE.txt', (ROOT / 'licenses/runtime/FFmpeg-LGPL-NOTICE.txt').read_bytes())
    add(files, 'delivery-tools/sources.lock.json', json_bytes(lock))
    required = ['ffmpeg/configure', 'ffmpeg/Makefile', 'ffmpeg/BUILD.gn', 'ffmpeg/ffmpeg_generated.gni',
                'opus/BUILD.gn', 'opus/src/COPYING', 'opus/README.chromium',
                'chromium-build-context/LICENSE', 'electron-build-context/electron/LICENSE',
                'chromium-build-context/build/buildflag_header.gni',
                'chromium-build-context/build/config/compiler/compiler.gni',
                'chromium-build-context/build/config/sanitizers/sanitizers.gni',
                'electron-build-context/build-tools/LICENSE',
                'chromium-build-context/media/ffmpeg/scripts/build_ffmpeg.py',
                'chromium-build-context/media/ffmpeg/scripts/generate_gn.py',
                'chromium-build-context/tools/generate_stubs/generate_stubs.py',
                'toolchain/nasm-source/nasm_assemble.gni']
    for name in required:
        require(name in files and files[name][1].strip(), '必需源码或许可缺失：' + name)
    identities = {row['id']: row for row in lock['snapshots']}
    require(identities['ffmpeg']['commit'] == metadata['ffmpeg']['commit']
            and identities['ffmpeg']['tree'] == metadata['ffmpeg']['tree'], 'FFmpeg 来源身份与 manifest 不一致')
    for row in lock['snapshots']:
        for linked in row.get('gitlinks', {}).values():
            require(any(other['commit'] == linked for other in lock['snapshots']), '固定子模块源码未完整纳入')
    deps = files['chromium-build-context/DEPS'][1].decode()
    for name in ['libcxx', 'libcxxabi', 'compiler-rt', 'llvm-libc-header-context', 'nasm']:
        require(identities[name]['commit'] in deps, '依赖 pin 不属于固定 Chromium DEPS：' + name)
    require(all(row['commit'] == metadata['chromium']['commit'] for row in lock['snapshots'] if row['id'].startswith('chromium-')), 'Chromium 源码 revision 不一致')
    opus_src = {name.removeprefix('opus/src/'): value for name, value in files.items() if name.startswith('opus/src/')}
    require(git_tree(opus_src) == metadata['opus']['src_tree'], '实际 Chromium Opus src tree 身份不符')
    licenses = [name for name in sorted(files) if re.search(r'(^|/)(LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|CREDITS[^/]*)$', name, re.I)]
    manifest = {**metadata, 'generated_configs': configs, 'source_trees': trees, 'build_inputs': lock['blobs'],
                'source_delivery_strategy': 'conservative_superset', 'llvm_runtime_source_strategy': 'FULL_FIXED_SPLIT_REPOS',
                'reproducibility': {'official_binary_bit_reproduction': False, 'official_target_graph_receipt': 'unavailable', 'official_link_receipt': 'unavailable'},
                'inventory_scope': '全部归档文件；包内 manifest 自身除外，以避免循环摘要。外置 manifest 另含完整 archive_inventory。',
                'license_files': licenses, 'file_inventory': inventory(files),
                'source_archive': {'sha256': None, 'reason': '最终归档摘要仅由外置 manifest 记录，避免自引用。'}}
    return files, manifest


def write_archive(path, prefix, files):
    # 所有输入先核验通过；归档为全新文件，不覆盖既有候选。
    with path.open('xb') as raw:
        with lzma.LZMAFile(raw, 'w', format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for name, (mode, value) in sorted(files.items()):
                    member = tarfile.TarInfo(prefix + '/' + name)
                    member.mtime = member.uid = member.gid = 0
                    member.uname = member.gname = ''
                    member.mode = 0o755 if mode == '100755' else 0o644
                    if mode == '120000':
                        member.type = tarfile.SYMTYPE
                        member.mode = 0o777
                        member.linkname = value.decode()
                        archive.addfile(member)
                    else:
                        member.size = len(value)
                        archive.addfile(member, io.BytesIO(value))


def external(path):
    resolved = path.resolve()
    require(not resolved.is_relative_to(ROOT), '缓存与生成结果必须位于仓库外')
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True, help='仓库外固定源码缓存')
    parser.add_argument('--output', type=Path, required=True, help='仓库外全新交付目录')
    parser.add_argument('--download', action='store_true', help='仅从锁定的官方地址取得缺少的缓存')
    args = parser.parse_args()
    cache, output = external(args.cache), external(args.output)
    require(not output.exists(), '交付目录已经存在，拒绝覆盖')
    cache.mkdir(parents=True, exist_ok=True)
    files, manifest = collect(cache, args.download)
    version = manifest['privateradar']['version']
    prefix = 'PrivateRadar-' + version + '-ffmpeg-corresponding-source'
    add(files, MANIFEST, json_bytes(manifest))
    output.mkdir(parents=True)
    archive = output / (prefix + '.tar.xz')
    write_archive(archive, prefix, files)
    size = archive.stat().st_size
    require(size < LIMIT, '发行资产体积达到或超过 2 GiB；禁止自动拆分')
    extracted = read_tar(archive)
    require(inventory(extracted) == inventory({prefix + '/' + name: value for name, value in files.items()}), '归档解包内容与完整清单不一致')
    final = {**manifest, 'archive_inventory': inventory(files), 'source_archive': {
        'file': archive.name, 'bytes': size, 'sha256': digest(archive.read_bytes()),
        'uncompressed_source_bytes': sum(len(value) for _, value in files.values()),
        'files': len(files), 'format': 'tar.xz / PAX / XZ CRC64 preset 6', 'order': '路径排序',
        'mtime': 0, 'uid': 0, 'gid': 0, 'owner_names': '', 'modes': 'Git 普通/可执行/符号链接权限',
        'extraction_verified': True, 'release_asset_limit_bytes_exclusive': LIMIT,
        'release_asset_limit_source': 'https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases',
        'uploaded': False}}
    (output / MANIFEST).write_bytes(json_bytes(final))
    print(json.dumps({'状态': 'PASS', '文件数': len(files), '归档字节': size, 'SHA256': final['source_archive']['sha256']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('源码交付失败：' + str(error), file=sys.stderr)
        sys.exit(1)
