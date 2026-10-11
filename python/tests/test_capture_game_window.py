"""截图等待预算、自动回退与写入失败的回归测试，无需安装 ok 或连接游戏。"""
import importlib.util
import io
import json
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from _test_tmp import make_tmp_dir


def module(name, **attributes):
    result = types.ModuleType(name)
    result.__dict__.update(attributes)
    return result


window = module('ok.util.window', find_hwnd=Mock(return_value=('game', 123)),
                windows_graphics_available=lambda: True)
wgc = module('ok.device.capture_methods.windows_graphics')
bitblt = module('ok.device.capture_methods.bitblt_utils', BitBltCtxDummy=Mock,
                capture_by_bitblt=Mock(), capture_desktop_by_bitblt=Mock(),
                clean_up_bitblt=Mock(), clean_up_desktop_bitblt=Mock())
cv2 = module('cv2', imwrite=Mock(return_value=True), resize=Mock(), INTER_LINEAR=1)
gui = module('win32gui', GetClientRect=lambda _: (0, 0, 640, 480),
             ClientToScreen=lambda *_: (10, 20), GetWindowRect=lambda _: (0, 0, 650, 500))
dependencies = {m.__name__: m for m in (window, wgc, bitblt, cv2, gui,
                module('win32api'), module('win32con'))}
spec = importlib.util.spec_from_file_location('capture_under_test',
        Path(__file__).resolve().parents[1] / 'capture_game_window.py')
capture = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, dependencies):
    spec.loader.exec_module(capture)


class FakeWgc:
    instances = []
    frame = None
    connected_value = True
    wait_for_frame = False
    raises = False

    def __init__(self, stub):
        self.stub = stub
        self.closed = False
        self.calls = 0
        self.last_size = None
        self.instances.append(self)

    def connected(self):
        return self.connected_value

    def get_frame(self):
        self.calls += 1
        if self.raises:
            raise RuntimeError('backend failure')
        if self.wait_for_frame:
            self.stub.app_exit_event.wait(4)
        return self.frame

    def close(self):
        self.closed = True


class Frame:
    shape = (480, 640, 3)

    def copy(self):
        return self


class CaptureTest(unittest.TestCase):
    def setUp(self):
        capture._close_wgc_session()
        capture._REUSE_WGC = False
        self.addCleanup(capture._close_wgc_session)
        self.modules = patch.dict(sys.modules, dependencies)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        FakeWgc.instances = []
        FakeWgc.frame = None
        FakeWgc.connected_value = True
        FakeWgc.wait_for_frame = False
        FakeWgc.raises = False
        wgc.WindowsGraphicsCaptureMethod = FakeWgc
        cv2.imwrite.reset_mock(return_value=True)
        cv2.imwrite.return_value = True
        bitblt.clean_up_bitblt.reset_mock()
        self.output = str(Path(make_tmp_dir('capture')) / 'shot.png')

    def test_frame_returns_immediately_and_closes(self):
        FakeWgc.frame = Frame()
        started = time.monotonic()
        self.assertIs(capture._capture_wgc(123, 640, 480), FakeWgc.frame)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(FakeWgc.instances[0].closed)
        self.assertTrue(FakeWgc.instances[0].stub.app_exit_event.is_set())

    def test_initialization_failure_does_not_retry_or_sleep(self):
        FakeWgc.connected_value = False
        started = time.monotonic()
        self.assertIsNone(capture._capture_wgc(123, 640, 480))
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(FakeWgc.instances[0].calls, 0)
        self.assertTrue(FakeWgc.instances[0].closed)

    def test_reused_session_requests_a_new_frame_and_rebuilds_after_resize(self):
        capture._REUSE_WGC = True
        first, second = Frame(), Frame()
        FakeWgc.frame = first
        self.assertIs(capture._capture_wgc(123, 640, 480), first)
        FakeWgc.frame = second
        self.assertIs(capture._capture_wgc(123, 640, 480), second)
        self.assertEqual(len(FakeWgc.instances), 1)
        self.assertEqual(FakeWgc.instances[0].calls, 2)
        self.assertFalse(FakeWgc.instances[0].closed)
        capture._capture_wgc(123, 800, 600)
        self.assertEqual(len(FakeWgc.instances), 2)
        self.assertTrue(FakeWgc.instances[0].closed)

    def test_timeout_discards_reused_session(self):
        capture._REUSE_WGC = True
        FakeWgc.frame = Frame()
        capture._capture_wgc(123, 640, 480)
        FakeWgc.frame = None
        FakeWgc.wait_for_frame = True
        self.assertIsNone(capture._capture_wgc(123, 640, 480, timeout=0.05))
        self.assertIsNone(capture._wgc_session)
        self.assertTrue(FakeWgc.instances[0].closed)

    def test_blocked_frame_request_is_cancelled_within_budget(self):
        FakeWgc.wait_for_frame = True
        started = time.monotonic()
        self.assertIsNone(capture._capture_wgc(123, 640, 480, timeout=0.08))
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(FakeWgc.instances[0].calls, 1)
        self.assertTrue(FakeWgc.instances[0].closed)

    def test_fast_empty_requests_share_one_deadline(self):
        started = time.monotonic()
        self.assertIsNone(capture._capture_wgc(123, 640, 480, attempts=100, timeout=0.08))
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertLessEqual(FakeWgc.instances[0].calls, 3)

    def test_backend_exception_closes_session(self):
        FakeWgc.raises = True
        self.assertIsNone(capture._capture_wgc(123, 640, 480))
        self.assertTrue(FakeWgc.instances[0].closed)

    def test_auto_falls_back_and_applies_processor_before_save(self):
        frame, processed = Frame(), Frame()
        processor = Mock(return_value=processed)
        with patch.object(capture, '_capture_wgc', return_value=None) as first, \
             patch.object(capture, '_capture_bitblt', return_value=frame) as fallback, \
             patch.object(capture, '_capture_foreground') as foreground:
            capture.capture(self.output, processor=processor)
        first.assert_called_once_with(123, 640, 480, timeout=1.5)
        fallback.assert_called_once()
        foreground.assert_not_called()
        processor.assert_called_once_with(frame)
        cv2.imwrite.assert_called_once_with(self.output, processed)

    def test_explicit_wgc_keeps_a_larger_budget_and_never_falls_back(self):
        with patch.object(capture, '_capture_wgc', return_value=None) as first, \
             patch.object(capture, '_capture_bitblt') as fallback:
            with self.assertRaises(RuntimeError):
                capture.capture(self.output, method='wgc')
        first.assert_called_once_with(123, 640, 480, timeout=3.0)
        fallback.assert_not_called()

    def test_failed_write_is_reported_as_failure(self):
        cv2.imwrite.return_value = False
        with patch.object(capture, '_capture_bitblt', return_value=Frame()):
            with self.assertRaisesRegex(RuntimeError, 'could not be written'):
                capture.capture(self.output, method='bitblt')

    def test_bitblt_resources_are_released_after_failure(self):
        with patch.object(capture, '_get_scaling_ratios', return_value=(1, 1)), \
             patch.object(capture, 'capture_by_bitblt', side_effect=RuntimeError('GDI failure')):
            with self.assertRaises(RuntimeError):
                capture._capture_bitblt(123, 640, 480, 0, 0)
        bitblt.clean_up_bitblt.assert_called_once_with(capture._ctx)

    def test_server_reads_each_request_and_restarts_after_source_change(self):
        config = Path(make_tmp_dir('capture-source')) / 'config.py'
        config.write_text('version = 1', encoding='utf-8')
        protocol = io.StringIO()
        def requests():
            yield json.dumps({'id': 1, 'output_path': self.output, 'project_dir': str(config.parent)}) + '\n'
            config.write_text('version = 222', encoding='utf-8')
            yield json.dumps({'id': 2, 'output_path': self.output, 'project_dir': str(config.parent)}) + '\n'
        with patch.object(sys, 'stdin', requests()), \
             patch.object(capture, '_PROTOCOL_STDOUT', protocol), \
             patch.object(capture, 'load_screenshot_processor', return_value=None), \
             patch.object(capture, '_project_sources', side_effect=lambda _: {str(config): capture._source_signature(config)}), \
             patch.object(capture, 'capture') as take:
            capture.serve()
        replies = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertTrue(replies[0]['ok'])
        self.assertTrue(replies[1]['restart'])
        self.assertEqual(take.call_count, 1)

    def test_server_reloads_processor_for_each_shot(self):
        requests = [json.dumps({'id': n, 'output_path': self.output, 'project_dir': 'project'}) + '\n'
                    for n in (1, 2)]
        protocol = io.StringIO()
        with patch.object(sys, 'stdin', requests), \
             patch.object(capture, '_PROTOCOL_STDOUT', protocol), \
             patch.object(capture, '_project_sources', return_value={}), \
             patch.object(capture, 'load_screenshot_processor', return_value=None) as load, \
             patch.object(capture, 'capture'):
            capture.serve()
        self.assertEqual(load.call_count, 2)
        self.assertTrue(all(json.loads(line)['ok'] for line in protocol.getvalue().splitlines()))

    def test_probe_reads_current_source_without_importing_config_or_capturing(self):
        root = Path(make_tmp_dir('capture-probe'))
        config = root / 'config.py'
        protocol = io.StringIO()
        def requests():
            for n in (1, 2):
                config.write_text("raise RuntimeError('must not execute')\n"
                                  + "config = {'windows': {'exe': ['game%d.exe']}}" % n, encoding='utf-8')
                yield json.dumps({'id': n, 'op': 'probe', 'project_dir': str(root)}) + '\n'
            yield json.dumps({'id': 3, 'op': 'probe', 'project_dir': str(root / 'missing')}) + '\n'
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        self.addCleanup(lambda: sys.path.pop(0))
        with patch.object(sys, 'stdin', requests()), \
             patch.object(capture, '_PROTOCOL_STDOUT', protocol), \
             patch.object(capture, 'load_screenshot_processor') as load, \
             patch.object(capture, 'capture') as take:
            capture.serve()
        replies = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual(replies[0]['config']['exe'], ['game1.exe'])
        self.assertEqual(replies[1]['config']['exe'], ['game2.exe'])
        self.assertFalse(replies[2]['config']['ok'])
        load.assert_not_called()
        take.assert_not_called()

    def test_source_watch_includes_project_modules_and_excludes_virtualenv(self):
        root = Path(make_tmp_dir('capture-watch'))
        config = root / 'config.py'
        local = root / 'src' / 'processor.py'
        dependency = root / '.venv' / 'Lib' / 'cv2.py'
        for file in (config, local, dependency):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('version = 1', encoding='utf-8')
        probe = module('probe_window_config', _resolve_config_path=lambda _: str(config))
        with patch.dict(sys.modules, {'probe_window_config': probe,
              'local_processor': module('local_processor', __file__=str(local)),
              'dependency': module('dependency', __file__=str(dependency))}):
            sources = capture._project_sources(str(root))
        self.assertIn(str(config), sources)
        self.assertIn(capture.os.path.normcase(str(local)), sources)
        self.assertNotIn(capture.os.path.normcase(str(dependency)), sources)


if __name__ == '__main__':
    unittest.main()
