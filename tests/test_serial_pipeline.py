# tests/test_serial_pipeline.py
"""
Unit tests for the Serial Action Pipeline & Single-Flight Executor.
Validates state machine invariants, concurrency violation prevention,
process mutual exclusion, and fail-fast circuit breaking.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.framework.pipeline import (
    PipelineStage,
    PipelineConcurrencyViolationError,
    CircuitBreakerError,
    ProcessLock,
    ProcessLockError,
    AtomicAction,
    ActionResult,
    SerialActionExecutor
)


class MockAction(AtomicAction):
    def __init__(self, name, allowed_stages, next_stage, success=True, error_msg="fail"):
        self._name = name
        self._allowed_stages = allowed_stages
        self._next_stage = next_stage
        self._success = success
        self._error_msg = error_msg
        self.executed = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def allowed_stages(self):
        return self._allowed_stages

    @property
    def next_stage(self):
        return self._next_stage

    def execute(self, ctx, cdp) -> ActionResult:
        self.executed = True
        if self._success:
            return ActionResult(True, f"{self._name} succeeded")
        return ActionResult(False, self._error_msg)


class TestSerialPipeline(unittest.TestCase):

    def test_process_lock_acquisition_and_conflict(self):
        with tempfile.NamedTemporaryFile(delete=True) as tmp:
            lock_path = tmp.name

        lock1 = ProcessLock(lock_path)
        lock1.acquire()
        self.assertTrue(lock1._acquired)
        self.assertTrue(os.path.exists(lock_path))

        # Second lock attempt must fail
        lock2 = ProcessLock(lock_path)
        with self.assertRaises(ProcessLockError):
            lock2.acquire()

        # Release first lock
        lock1.release()
        self.assertFalse(lock1._acquired)
        self.assertFalse(os.path.exists(lock_path))

        # Now second lock can acquire
        lock2.acquire()
        self.assertTrue(lock2._acquired)
        lock2.release()

    def test_executor_state_machine_transition_success(self):
        executor = SerialActionExecutor()
        self.assertEqual(executor.current_stage, PipelineStage.IDLE)

        a1 = MockAction("StageInput", {PipelineStage.IDLE}, PipelineStage.STAGED)
        a2 = MockAction("Dispatch", {PipelineStage.STAGED}, PipelineStage.DISPATCHED)
        a3 = MockAction("Settle", {PipelineStage.DISPATCHED}, PipelineStage.SETTLED)
        a4 = MockAction("Cooldown", {PipelineStage.SETTLED}, PipelineStage.IDLE)

        res = executor.run_pipeline(None, None, [a1, a2, a3, a4])
        self.assertTrue(res.success)
        self.assertEqual(res.executed_actions, 4)
        self.assertEqual(executor.current_stage, PipelineStage.IDLE)

    def test_executor_concurrency_violation_halts(self):
        executor = SerialActionExecutor()
        # a2 expects STAGED, but current is IDLE
        a1 = MockAction("InvalidDirectDispatch", {PipelineStage.STAGED}, PipelineStage.DISPATCHED)

        with self.assertRaises(PipelineConcurrencyViolationError):
            executor.run_pipeline(None, None, [a1])

    def test_circuit_breaker_halts_on_action_failure(self):
        executor = SerialActionExecutor()
        a1 = MockAction("Step1", {PipelineStage.IDLE}, PipelineStage.STAGED, success=True)
        a2 = MockAction("Step2Fail", {PipelineStage.STAGED}, PipelineStage.DISPATCHED, success=False, error_msg="Network drop")
        a3 = MockAction("Step3ShouldNotRun", {PipelineStage.DISPATCHED}, PipelineStage.SETTLED, success=True)

        res = executor.run_pipeline(None, None, [a1, a2, a3])
        self.assertFalse(res.success)
        self.assertIn("Network drop", str(res.error))
        self.assertTrue(a1.executed)
        self.assertTrue(a2.executed)
        self.assertFalse(a3.executed, "Action after circuit breaker trip must not execute!")
        self.assertEqual(executor.current_stage, PipelineStage.IDLE, "Stage must reset to IDLE safely on failure")


if __name__ == "__main__":
    unittest.main()
