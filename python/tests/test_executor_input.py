"""Cover idle Windows pipes, command framing, EOF and startup cancellation."""

import io
import os
from pathlib import Path
import queue
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import executor_input
import run_executor


class CommandLinesTests(unittest.TestCase):
    def test_chunked_utf8_crlf_multiple_commands_and_final_line(self):
        text = 'params {"任务": "闪避\\n开启"}\r\n\nresume\nstop'
        payload = text.encode("utf-8")
        chunks = iter([payload[:10], b"", payload[10:11], payload[11:23], payload[23:], None])
        stream = SimpleNamespace(encoding="utf-8")
        with patch.object(executor_input, "_windows_pipe_reader", return_value=lambda: next(chunks)):
            lines = list(executor_input.iter_command_lines(stream, threading.Event()))
        self.assertEqual(lines, ['params {"任务": "闪避\\n开启"}\n', '\n', 'resume\n', 'stop'])

    def test_idle_wait_can_be_cancelled_without_input(self):
        cancel = threading.Event()
        with patch.object(executor_input, "_windows_pipe_reader", return_value=lambda: b""):
            with patch.object(cancel, "wait", side_effect=lambda timeout: cancel.set()) as wait:
                self.assertEqual(list(executor_input.iter_command_lines(
                    SimpleNamespace(encoding="utf-8"), cancel)), [])
        wait.assert_called_once_with(0.025)

    def test_file_or_non_windows_input_keeps_line_protocol(self):
        with patch.object(executor_input, "_windows_pipe_reader", return_value=None):
            self.assertEqual(list(executor_input.iter_command_lines(
                io.StringIO("pause\nresume\n"), threading.Event())), ["pause\n", "resume\n"])

    def test_pipe_errors_are_not_treated_as_eof(self):
        def fail():
            raise OSError("pipe failed")
        with patch.object(executor_input, "_windows_pipe_reader", return_value=fail):
            with self.assertRaisesRegex(OSError, "pipe failed"):
                list(executor_input.iter_command_lines(SimpleNamespace(encoding="utf-8"), threading.Event()))

    def test_listener_preserves_commands_and_stops_before_later_input(self):
        commands = queue.Queue()
        cancel = threading.Event()
        stream = io.StringIO('\nparams {"key": "中文"}\nstop\nresume\n')
        with patch.object(sys, "stdin", stream):
            run_executor.start_stdin_listener(commands, cancel)
            self.assertTrue(cancel.wait(1))
        self.assertEqual(commands.get_nowait(), 'params {"key": "中文"}\n')
        self.assertEqual(commands.get_nowait(), 'stop\n')
        self.assertTrue(commands.empty())

    def test_control_marker_and_newline_are_written_together(self):
        output = SimpleNamespace(write=Mock(), flush=Mock())
        with patch.object(sys, "stdout", output):
            run_executor._emit('OK_TOOLKIT_STATE:{"paused": false}')
        output.write.assert_called_once_with('OK_TOOLKIT_STATE:{"paused": false}\n')
        output.flush.assert_called_once_with()


@unittest.skipUnless(os.name == "nt", "Windows pipe transport")
class WindowsPipeTests(unittest.TestCase):
    def test_empty_pipe_does_not_read_and_closed_pipe_reports_eof(self):
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "r", encoding="utf-8") as stream:
            try:
                reader = executor_input._windows_pipe_reader(stream)
                self.assertIsNotNone(reader)
                self.assertEqual(reader(), b"")
                os.write(write_fd, "中文\r\n".encode("utf-8"))
                self.assertEqual(reader(), "中文\r\n".encode("utf-8"))
                self.assertEqual(reader(), b"")
            finally:
                os.close(write_fd)
            self.assertIsNone(reader())

    def test_idle_real_pipe_listener_exits_when_cancelled_without_writing(self):
        read_fd, write_fd = os.pipe()
        cancel = threading.Event()
        started = threading.Event()
        lines = []
        with os.fdopen(read_fd, "r", encoding="utf-8") as stream:
            def listen():
                started.set()
                lines.extend(executor_input.iter_command_lines(stream, cancel))
            worker = threading.Thread(target=listen, daemon=True)
            worker.start()
            try:
                self.assertTrue(started.wait(1))
                self.assertFalse(cancel.wait(0.1))
                # The IDE sends no command. Cancellation still releases the
                # reader instead of leaving a thread blocked inside FileIO.
                cancel.set()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(lines, [])
            finally:
                os.close(write_fd)
                worker.join(1)

    def test_real_pipe_reassembles_split_utf8_and_delivers_eof_tail(self):
        read_fd, write_fd = os.pipe()
        cancel = threading.Event()
        lines = []
        with os.fdopen(read_fd, "r", encoding="utf-8") as stream:
            worker = threading.Thread(
                target=lambda: lines.extend(executor_input.iter_command_lines(stream, cancel)), daemon=True)
            worker.start()
            try:
                payload = 'params {"开关": true}\r\nresume\nstop'.encode("utf-8")
                os.write(write_fd, payload[:9])
                cancel.wait(0.05)
                os.write(write_fd, payload[9:])
            finally:
                os.close(write_fd)
            worker.join(1)
            self.assertFalse(worker.is_alive())
        self.assertEqual(lines, ['params {"开关": true}\n', 'resume\n', 'stop'])


if __name__ == "__main__":
    unittest.main()
