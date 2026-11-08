#!/usr/bin/env python3
"""
scripts/framework/scenario_provider.py
--------------------------------------
Gemini Exporter 在线交互测试统一对话池提供者 (OnlineScenarioProvider).

核心铁律与设计职责：
1. 作为全项目（无论是 E2E 实跑测试还是全视觉 UI 质检实测）与真实在线 Gemini 发帖交互的【唯一合法事实来源】；
2. 彻底杜绝硬编码 Prompt、静态旁路数据集与题材重复使用；
3. 原子出队并持久化归档（Pop-and-Archive）：corpus 文件永不被修改，出队记录与归档
   写入 temp/scenario_pool/（git-ignored）；显式传入的自定义路径保持传统的直接改文件语义；
4. 保证无论是多轮推演、Imagen 生图还是瞬态自毁发帖，每次取出的对话题材在全生命周期内绝对唯一。
"""

import sys
import os
import json
import time
from datetime import datetime
from typing import Dict, Any, List, Optional

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from manage_scenario_pool import (
    get_effective_pool,
    record_consumption,
    is_corpus_path,
    RUNTIME_ARCHIVE_PATH,
)

DEFAULT_POOL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_scenario_pool.json"))
DEFAULT_ARCHIVE_PATH = RUNTIME_ARCHIVE_PATH
TARGET_POOL_SIZE = 20


class OnlineScenarioProvider:
    """在线测试场景池统一调度提供者（单例/标准提供源）"""

    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super(OnlineScenarioProvider, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, pool_path: str = DEFAULT_POOL_PATH, archive_path: str = DEFAULT_ARCHIVE_PATH):
        if getattr(self, "_initialized", False) and pool_path == DEFAULT_POOL_PATH and archive_path == DEFAULT_ARCHIVE_PATH:
            return
        self.pool_path = pool_path
        self.archive_path = archive_path
        self._initialized = True

    @classmethod
    def reset(cls):
        """仅供测试或重置时使用"""
        cls._instance = None

    def _load_json(self, path: str, default: Any) -> Any:
        if not os.path.isfile(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ [ScenarioProvider] 读取 JSON 异常 ({path}): {e}")
            return default

    def _save_json(self, path: str, data: Any):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _read_pool(self) -> List[Dict[str, Any]]:
        if is_corpus_path(self.pool_path):
            return get_effective_pool(self.pool_path)
        return self._load_json(self.pool_path, [])

    def get_status(self) -> Dict[str, Any]:
        """查询场景池当前水位与健康度"""
        pool = self._read_pool()
        imagen_count = sum(1 for s in pool if "imagen" in s.get("features", []))
        return {
            "count": len(pool),
            "target": TARGET_POOL_SIZE,
            "deficit": max(0, TARGET_POOL_SIZE - len(pool)),
            "has_imagen": imagen_count,
            "is_healthy": len(pool) >= TARGET_POOL_SIZE and imagen_count >= 2
        }

    def pop_scenario(self, required_features: Optional[List[str]] = None, min_turns: int = 2) -> Dict[str, Any]:
        """
        从场景池中原子提取一个符合特征要求的测试场景，并立即归档留痕。
        出队后场景将从 pool 中移除，杜绝后续测试重复使用相同题材。
        """
        pool = self._read_pool()
        if not pool:
            raise RuntimeError("❌ [场景池安全门禁拦截] 场景池已枯竭 (0 个可用场景)！请先运行 `python3 scripts/manage_scenario_pool.py status` 并补充场景！")

        target_idx = None

        if required_features:
            for idx, s in enumerate(pool):
                feats = s.get("features", [])
                turns = s.get("turns", [])
                if all(rf in feats for rf in required_features) and len(turns) >= min_turns:
                    target_idx = idx
                    break

        if target_idx is None and not required_features:
            # 无特定特征时按轮次长度就绪出队；必测特性不得降级。
            for idx, s in enumerate(pool):
                if len(s.get("turns", [])) >= min_turns:
                    target_idx = idx
                    break

        if target_idx is None:
            raise RuntimeError(f"场景池缺少符合要求的场景: features={required_features or []}, min_turns={min_turns}")

        selected = pool.pop(target_idx)

        if is_corpus_path(self.pool_path):
            # corpus 永不修改：消费记录进 git-ignored 的运行时状态
            record_consumption([selected], consumed_by=os.path.basename(sys.argv[0]))
        else:
            # 显式自定义路径：传统语义，直接改文件
            self._save_json(self.pool_path, pool)
            archive = self._load_json(self.archive_path, [])
            archived_item = dict(selected)
            archived_item["consumed_at"] = datetime.now().isoformat()
            archived_item["consumed_by"] = os.path.basename(sys.argv[0])
            archive.append(archived_item)
            self._save_json(self.archive_path, archive)

        print(f"🏊 [场景池调度] 原子出队场景: [{selected.get('id')}] '{selected.get('title')}' ({len(selected.get('turns', []))} 轮)")
        print(f"   📊 场景池剩余水位: {len(pool)}/{TARGET_POOL_SIZE} (已归档至运行时状态)")

        return selected

    def pop_ephemeral_query(self) -> str:
        """
        为瞬态自毁会话 (Ephemeral Chat) 生成一个干净唯一的快速单轮提问。
        专为瞬态自毁与侧边栏删除实时剥离设计，要求模型在极短时间内（10-15s）回复完毕，
        绝不占用或消耗场景池中用于多轮深度推演的高价值学术场景。
        """
        ts = int(time.time())
        return f"请简要阐述分布式计算系统的瞬态一致性原理 (校验戳: {ts})，请用一句话回答。"
