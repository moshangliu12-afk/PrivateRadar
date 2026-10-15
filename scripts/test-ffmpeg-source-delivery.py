"""源码交付的独立拒绝行为测试，不涉及产品或业务断言。"""

import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('prepare-ffmpeg-corresponding-source.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryTests(unittest.TestCase):
    def test_project_identity(self):
        metadata = delivery.read_json(delivery.INPUT / 'provenance-inputs.json')
        delivery.validate_project(metadata)
        metadata['electron']['version'] = '0.0.0'
        with self.assertRaisesRegex(ValueError, 'Electron 版本与来源清单不一致'):
            delivery.validate_project(metadata)

    def test_project_version_mismatch(self):
        metadata = delivery.read_json(delivery.INPUT / 'provenance-inputs.json')
        metadata['privateradar']['version'] = '0.0.0'
        with self.assertRaisesRegex(ValueError, '项目版本改变'):
            delivery.validate_project(metadata)

    def test_missing_source(self):
        lock = delivery.read_json(delivery.INPUT / 'sources.lock.json')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, '缺少固定源码'):
                delivery.fetch(lock['snapshots'][0], Path(directory), False)

    def test_wrong_revision(self):
        source = dict(delivery.read_json(delivery.INPUT / 'sources.lock.json')['snapshots'][0])
        source['commit'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'revision 与固定下载地址不一致'):
            delivery.validate_origin(source)

    def test_wrong_source_tree(self):
        files = {'LICENSE': ('100644', '合成许可'.encode())}
        source = {'id': 'synthetic', 'tree': '0' * 40, 'required_licenses': ['LICENSE']}
        with self.assertRaisesRegex(ValueError, 'revision/tree'):
            delivery.validate_source(source, files)

    def test_gitlink_is_not_silently_omitted(self):
        files = {'README': ('100644', b'synthetic wrapper\n')}
        links = {'src': '1' * 40}
        source = {'id': 'synthetic', 'tree': delivery.git_tree(files, links), 'gitlinks': links, 'required_licenses': []}
        delivery.validate_source(source, files)
        source.pop('gitlinks')
        with self.assertRaisesRegex(ValueError, 'revision/tree'):
            delivery.validate_source(source, files)

    def test_license_missing(self):
        files = {'source.c': ('100644', b'int synthetic;\n')}
        source = {'id': 'synthetic', 'tree': delivery.git_tree(files), 'required_licenses': ['LICENSE']}
        with self.assertRaisesRegex(ValueError, '必需许可缺失'):
            delivery.validate_source(source, files)

    def test_corrupt_cache(self):
        source = delivery.read_json(delivery.INPUT / 'sources.lock.json')['blobs'][0]
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / source['cache_file']).write_bytes(b'synthetic corruption')
            with self.assertRaisesRegex(ValueError, '缓存摘要不匹配'):
                delivery.fetch(source, Path(directory), False)

    def test_path_escape_and_hardlink(self):
        for name in ['../outside', '/absolute', 'x/../../outside', 'x\\outside']:
            with self.assertRaises(ValueError):
                delivery.safe_name(name)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.tar'
            with tarfile.open(path, 'w') as archive:
                member = tarfile.TarInfo('source-link')
                member.type = tarfile.LNKTYPE
                member.linkname = 'target'
                archive.addfile(member)
            with self.assertRaisesRegex(ValueError, '对象类型'):
                delivery.read_tar(path)

    def test_modes_links_and_order_are_deterministic(self):
        files = {'z': ('100644', b'synthetic\n'), 'a/run': ('100755', b'#!/bin/sh\n'), 'a/link': ('120000', b'../z')}
        with tempfile.TemporaryDirectory() as directory:
            first, second = (Path(directory) / name for name in ['first.tar.xz', 'second.tar.xz'])
            delivery.write_archive(first, 'synthetic', files)
            delivery.write_archive(second, 'synthetic', dict(reversed(list(files.items()))))
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(delivery.read_tar(first), {'synthetic/' + name: value for name, value in files.items()})
            with self.assertRaises(FileExistsError):
                delivery.write_archive(first, 'synthetic', files)


class SourceBindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / 'repository'
        self.root.mkdir()
        self.git('init', '-q')
        self.input = self.root / 'source.txt'
        self.input.write_text('合成来源\n', encoding='utf-8')
        self.git('add', 'source.txt')
        self.git('-c', 'user.name=合成验证', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', '合成基线')
        self.commit = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def test_current_and_detached_head(self):
        self.assertEqual(delivery.current_source_commit(self.root), self.commit)
        self.git('checkout', '--detach', '-q')
        self.assertEqual(delivery.current_source_commit(self.root), self.commit)

    def test_dirty_tracked_file(self):
        self.input.write_text('合成未提交变更\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '干净工作区'):
            delivery.current_source_commit(self.root)

    def test_staged_change(self):
        self.input.write_text('合成暂存变更\n', encoding='utf-8')
        self.git('add', 'source.txt')
        with self.assertRaisesRegex(ValueError, '干净工作区'):
            delivery.current_source_commit(self.root)

    def test_untracked_input_and_official_entry(self):
        (self.root / 'untracked-source.txt').write_text('合成新增输入', encoding='utf-8')
        output, cache = self.directory / 'output', self.directory / 'cache'
        with patch.object(delivery, 'ROOT', self.root), patch.object(sys, 'argv', ['delivery', '--cache', str(cache), '--output', str(output)]):
            with self.assertRaisesRegex(ValueError, '干净工作区'):
                delivery.main()
        self.assertFalse(output.exists())
        self.assertFalse(cache.exists())

    def test_stale_manifest_and_missing_release_field(self):
        historical = delivery.read_json(delivery.INPUT / 'provenance-inputs.json')['privateradar']['source_commit_before_delivery_change']
        with self.assertRaisesRegex(ValueError, '与预期提交不一致'):
            delivery.verify_private_radar_source_binding(self.commit, {'privateradar': {'source_commit': historical}})
        with self.assertRaises(ValueError):
            delivery.verify_private_radar_source_binding(self.commit, {'privateradar': {'source_commit_before_delivery_change': historical}})

    def test_commit_format_and_git_failure(self):
        for value in [None, 'A' * 40, 'a' * 39, 'a' * 41, 'z' * 40]:
            with self.assertRaises(ValueError):
                delivery.validate_commit(value)
        with patch.object(delivery, 'git_text', side_effect=ValueError('合成 Git 读取失败')):
            with self.assertRaisesRegex(ValueError, 'Git 读取失败'):
                delivery.current_source_commit(self.root)

    def test_git_head_format_rejected_without_fallback(self):
        with patch.object(delivery, 'git_text', side_effect=[str(self.root), '', 'A' * 40]):
            with self.assertRaisesRegex(ValueError, '小写十六进制'):
                delivery.current_source_commit(self.root)

    def test_real_archive_manifest_binding(self):
        output, cache = self.directory / 'output', self.directory / 'cache'
        files = {'synthetic.c': ('100644', b'int synthetic;\n')}
        manifest = {'privateradar': {'version': 'synthetic', 'source_commit': self.commit}}
        with patch.object(delivery, 'ROOT', self.root), patch.object(delivery, 'collect', return_value=(files, manifest)), patch.object(sys, 'argv', ['delivery', '--cache', str(cache), '--output', str(output)]):
            delivery.main()
        external = delivery.read_json(output / delivery.MANIFEST)
        archive = next(output.glob('*.tar.xz'))
        extracted = delivery.read_tar(archive)
        internal = json.loads(next(value[1] for name, value in extracted.items() if name.endswith('/' + delivery.MANIFEST)))
        self.assertEqual(delivery.verify_private_radar_source_binding(self.commit, external), self.commit)
        self.assertEqual(delivery.verify_private_radar_source_binding(self.commit, internal), self.commit)

    def test_changed_head_during_material_preparation(self):
        output, cache = self.directory / 'output', self.directory / 'cache'
        manifest = {'privateradar': {'version': 'synthetic', 'source_commit': self.commit}}
        with patch.object(delivery, 'ROOT', self.root), patch.object(delivery, 'collect', return_value=({}, manifest)), patch.object(delivery, 'current_source_commit', side_effect=[self.commit, '0' * 40]), patch.object(sys, 'argv', ['delivery', '--cache', str(cache), '--output', str(output)]):
            with self.assertRaisesRegex(ValueError, '归档前 HEAD 改变'):
                delivery.main()
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
