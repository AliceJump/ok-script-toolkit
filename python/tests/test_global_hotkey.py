import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('global_hotkey', Path(__file__).resolve().parents[1] / 'global_hotkey.py')
hotkey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hotkey)


class ParentLifetimeTests(unittest.TestCase):
    def run_helper(self, parent_handle):
        events = []
        user = Mock()
        kernel = Mock()
        user.RegisterHotKey.return_value = True
        user.PeekMessageW.side_effect = lambda *args: events.append('queue') or False
        user.GetMessageW.return_value = 0
        kernel.GetCurrentThreadId.return_value = 42
        kernel.OpenProcess.side_effect = lambda *args: events.append('parent') or parent_handle
        kernel.WaitForSingleObject.return_value = 0
        user.PostThreadMessageW.side_effect = lambda *args: events.append('quit') or True

        class ImmediateThread:
            def __init__(self, target, **kwargs):
                self.target = target

            def start(self):
                self.target()

        output = io.StringIO()
        with patch.object(hotkey.sys, 'platform', 'win32'), \
             patch.object(hotkey.sys, 'argv', ['global_hotkey.py', '--parent-pid', '123']), \
             patch.object(hotkey.ctypes, 'WinDLL', side_effect=lambda name, **kwargs: user if name == 'user32' else kernel, create=True), \
             patch.object(hotkey.ctypes, 'get_last_error', return_value=87, create=True), \
             patch.object(hotkey.threading, 'Thread', ImmediateThread), \
             contextlib.redirect_stdout(output):
            result = hotkey.main()
        return result, output.getvalue(), events, user, kernel

    def test_missing_parent_exits_and_unregisters_hotkey(self):
        result, output, events, user, kernel = self.run_helper(0)
        self.assertEqual(result, 5)
        self.assertNotIn('READY', output)
        self.assertIn('ERROR parent_process', output)
        user.UnregisterHotKey.assert_called_once()
        user.GetMessageW.assert_not_called()
        kernel.WaitForSingleObject.assert_not_called()

    def test_already_exited_parent_posts_quit_after_queue_creation(self):
        result, output, events, user, kernel = self.run_helper(1234)
        self.assertEqual(result, 0)
        self.assertEqual(events, ['queue', 'parent', 'quit'])
        user.PostThreadMessageW.assert_called_once_with(42, hotkey.WM_QUIT, 0, 0)
        kernel.CloseHandle.assert_called_once_with(1234)
        user.UnregisterHotKey.assert_called_once()


if __name__ == '__main__':
    unittest.main()
