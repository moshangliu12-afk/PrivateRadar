"""源码交付的独立拒绝行为测试，不涉及产品或业务断言。"""

import importlib.util
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

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


if __name__ == '__main__':
    unittest.main()
