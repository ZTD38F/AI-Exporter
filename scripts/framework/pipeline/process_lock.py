# scripts/framework/pipeline/process_lock.py
"""
Process-Level Mutex Lock for Gemini Exporter Test Automation.
Ensures strictly one Tier 2 live runner runs on the system at any given moment,
preventing multiple processes or zombie tasks from connecting to the same Chrome
debugging port and causing overlapping/concurrent request floods.
"""

import os
import sys
import time
import atexit
from typing import Optional


class ProcessLockError(RuntimeError):
    """Raised when another test runner process is already running."""
    pass


class ProcessLock:
    def __init__(self, lock_file_path: Optional[str] = None):
        if lock_file_path:
            self.lock_file_path = os.path.abspath(lock_file_path)
        else:
            # Default lock in temp directory
            tmp_dir = os.environ.get("TMPDIR") or os.environ.get("TEMP") or "/tmp"
            self.lock_file_path = os.path.join(tmp_dir, "gemini_exporter_live_test.lock")

        self.fd = None
        self._acquired = False

    def acquire(self):
        """Acquires the exclusive process lock. Raises ProcessLockError on conflict."""
        if self._acquired:
            return

        try:
            self.fd = os.open(self.lock_file_path, os.O_CREAT | os.O_RDWR, 0o644)
        except Exception as e:
            raise ProcessLockError(f"无法打开或创建进程锁文件 '{self.lock_file_path}': {e}")

        # Platform-specific non-blocking exclusive lock
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            except (IOError, OSError):
                self._read_conflict_and_raise()
        else:
            import fcntl
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (IOError, OSError):
                self._read_conflict_and_raise()

        # Write lock info
        try:
            os.ftruncate(self.fd, 0)
            os.lseek(self.fd, 0, os.SEEK_SET)
            payload = (
                f"pid={os.getpid()}\n"
                f"started={time.strftime('%Y-%m-%d %H:%M:%S')}\n"
                f"args={' '.join(sys.argv)}\n"
            )
            os.write(self.fd, payload.encode("utf-8"))
            os.fsync(self.fd)
        except Exception:
            pass

        self._acquired = True
        atexit.register(self.release)

    def _read_conflict_and_raise(self):
        existing_info = "未知"
        try:
            os.lseek(self.fd, 0, os.SEEK_SET)
            content = os.read(self.fd, 1024).decode("utf-8", errors="ignore").strip()
            if content:
                existing_info = content.replace("\n", " | ")
        except Exception:
            pass

        try:
            os.close(self.fd)
        except Exception:
            pass
        self.fd = None

        err_msg = (
            f"❌【进程级排他安全拦截】检测到已有另一个 Tier 2 实跑测试实例正在运行！\n"
            f"   锁定文件: {self.lock_file_path}\n"
            f"   冲突进程信息: [{existing_info}]\n"
            f"   为了绝对确信不发生多进程并发请求导致账号封禁，当前启动已被主动终止！\n"
            f"   若确认前序进程已死，请手动清理锁文件后再试: rm -f {self.lock_file_path}"
        )
        raise ProcessLockError(err_msg)

    def release(self):
        """Releases the lock and removes the lock file."""
        if not self._acquired:
            return

        self._acquired = False
        try:
            if self.fd is not None:
                if os.name == "nt":
                    import msvcrt
                    try:
                        os.lseek(self.fd, 0, os.SEEK_SET)
                        msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                    except Exception:
                        pass
                else:
                    import fcntl
                    try:
                        fcntl.flock(self.fd, fcntl.LOCK_UN)
                    except Exception:
                        pass
                os.close(self.fd)
                self.fd = None
        except Exception:
            pass

        try:
            if os.path.exists(self.lock_file_path):
                os.remove(self.lock_file_path)
        except Exception:
            pass

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()
