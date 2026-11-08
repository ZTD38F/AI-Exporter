# scripts/framework/cases/base.py
"""
Base abstractions for Feature-Driven E2E test cases and DAG execution.
Gemini test context; common case/scheduler APIs are re-exported for compatibility.
"""

import os
import sys
import time
import json
import urllib.request
from typing import Dict, List, Optional, Any, Tuple

from scripts.framework.features import Feature, FeatureDomain, FeatureRegistry, TestStatus, TestResult
from scripts.framework.scenario_provider import OnlineScenarioProvider
from scripts.framework.lifecycle_tracker import SessionLifecycleTracker
from scripts.framework.pipeline import SerialActionExecutor
from scripts.framework.environment import TestEnvironment
from scripts.framework.integrity.model import validate_frozen_evidence

try:
    from scripts.cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url
except ImportError:
    from cdp_client import CDPConnection, get_tabs, get_extension_id, get_browser_ws_url, is_gemini_url


class TestContext:
    def __init__(
        self,
        port: int = 9222,
        output_dir: Optional[str] = None,
        dataset: Optional[Any] = None,
        delay: int = 6,
        takeout_zip: Optional[str] = None,
        pop_scenarios: bool = False
    ):
        self.port = port
        self.worktree_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        self.output_dir = os.path.abspath(output_dir or os.path.join(self.worktree_root, "tests", "output", "live_export"))
        self.delay = max(4, delay)
        self.takeout_zip = takeout_zip or os.path.abspath(os.path.join(self.worktree_root, "tests", "fixtures", "gemini_takeout_clean.zip"))
        self.start_time = time.time()

        self.provider = OnlineScenarioProvider()
        self.tracker = SessionLifecycleTracker()
        self.registry = FeatureRegistry()
        self.executor = SerialActionExecutor()

        self.env = TestEnvironment(
            port=self.port,
            output_dir=self.output_dir,
            repo_path=self.worktree_root
        )

        self._dataset_arg = dataset
        self.scenarios = []
        if isinstance(dataset, dict) and "scenarios" in dataset:
            self.scenarios = dataset["scenarios"]
        elif isinstance(dataset, list) and dataset:
            self.scenarios = dataset
        self._ext_id: Optional[str] = None
        self.chat_records: List[Dict[str, Any]] = []
        self.shared_data: Dict[str, Any] = {}
        os.makedirs(self.output_dir, exist_ok=True)

        if pop_scenarios:
            self.ensure_scenarios()

    def ensure_scenarios(self) -> List[Dict[str, Any]]:
        if not self.scenarios:
            print("🏊 [场景池调度] 提取 2 个实时对话场景；固定 golden 会话覆盖图片导出。")
            self.scenarios = [self.provider.pop_scenario(min_turns=2) for _ in range(2)]
        if len(self.scenarios) < 2 or any(len(sc.get("turns", [])) < 2 for sc in self.scenarios[:2]):
            raise RuntimeError("完整回归需要两个至少两轮的真实场景")
        return self.scenarios

    def record_turn(self, record: Dict[str, Any], result) -> None:
        """保存实际发送的 Prompt 和实际回复，供角色/轮次/会话绑定断言。"""
        if not result.success or not result.chat_id:
            raise RuntimeError("无法记录失败或无会话 ID 的轮次")
        if record.get("chat_id") and record["chat_id"] != result.chat_id:
            raise RuntimeError("回复会话 ID 与目标会话不一致")
        record["chat_id"] = result.chat_id
        evidence = {
            "prompt": result.prompt, "response": result.model_response,
            "has_images": result.has_images,
            **({"code_blocks": result.metadata["code_blocks"]} if "code_blocks" in result.metadata else {}),
            **({"execution_blocks": result.metadata["execution_blocks"]} if "execution_blocks" in result.metadata else {}),
        }
        record.setdefault("turn_evidence", []).append(evidence)
        if 'stream_turn_evidence' in record:
            record['stream_turn_evidence'].append(evidence)

    def freeze_turn_evidence(self, driver, record: Dict[str, Any]) -> None:
        """Preserve stream/in-place snapshots and freeze freshly hydrated webpage evidence."""
        record.setdefault('stream_turn_evidence', list(record['turn_evidence']))
        final_turns = driver.settled_conversation_evidence(
            record['chat_id'], [turn['prompt'] for turn in record['stream_turn_evidence']])
        validate_frozen_evidence(record['chat_id'], record['stream_turn_evidence'], final_turns)
        record['turn_evidence'] = final_turns
        in_place = getattr(driver, 'last_in_place_evidence', None)
        if isinstance(in_place, list):
            record['in_place_turn_evidence'] = in_place
        with open(os.path.join(self.output_dir, f"{record['chat_id']}_turn_evidence.json"), 'w', encoding='utf-8') as evidence_file:
            json.dump(record, evidence_file, ensure_ascii=False, indent=2)

    @property
    def ext_id(self) -> Optional[str]:
        return self.env.ext_id or self._ext_id

    @ext_id.setter
    def ext_id(self, val: Optional[str]):
        self._ext_id = val
        if hasattr(self, "env") and self.env:
            self.env.ext_id = val

    def get_gemini_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.get_gemini_tab()

    def ensure_gemini_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.ensure_gemini_tab()

    def get_options_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.get_options_tab()

    def ensure_options_tab(self) -> Optional[Dict[str, Any]]:
        return self.env.ensure_options_tab()

    def connect_gemini(self) -> CDPConnection:
        return self.env.connect_gemini()

    def connect_options(self) -> CDPConnection:
        return self.env.connect_options()

    def get_gemini_driver(self, cdp: Optional[CDPConnection] = None):
        """获取高层 Gemini 自动化驱动"""
        from scripts.framework.driver import GeminiPlatformDriver
        conn = cdp or self.connect_gemini()
        return GeminiPlatformDriver(conn)

    def get_platform_driver(self, cdp: Optional[CDPConnection] = None, platform_id: str = "gemini"):
        """获取当前配置的平台自动化驱动契约对象 (通过 PlatformRegistry 动态发现与创建)"""
        from scripts.framework.driver import PlatformRegistry
        conn = cdp or self.connect_gemini()
        return PlatformRegistry.create_driver(platform_id, conn)



# Compatibility exports for existing platform cases and callers.
from scripts.framework.scheduler import FeatureTestCase, DAGRunner
