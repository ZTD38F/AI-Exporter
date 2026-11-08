"""Local observation waits. Callers must never poll authenticated source APIs."""
import time


def wait_for(operation, timeout=90, interval=.5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = operation()
        if result:
            return result
        time.sleep(interval)
    raise TimeoutError('Live browser observation did not settle')
