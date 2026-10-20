#!/usr/bin/env python3
"""
scripts/manage_scenario_pool.py
---------------------------------
Gemini Exporter — 动态 20 题多模态测试场景池管理器。

实现规范：
1. 维护 20 个跨领域、多模态的高价值测试会话场景；
2. 每次实跑测试消费 2 个（1 个包含 Imagen 生图，1 个深度长文本），并自动归档；
3. 支持 status / validate / consume / topup / archive 等 CLI 指令；
4. AI 助手参与协作或提交 PR 前，必须将场景池补齐至 20 题。

状态模型：
- scripts/test_scenario_pool.json 是 git 跟踪的静态 corpus；consume 永不修改它，
  只有 topup 补充新场景时才会写入（有意的 content 变更，随 PR 提交）。
- 运行时状态（已消费 id、归档）放在 temp/scenario_pool/（git-ignored，每个 checkout 独立）。
"""

import sys
import os
import json
import time
import argparse
from datetime import datetime

TARGET_POOL_SIZE = 20
DEFAULT_POOL_PATH = os.path.join(os.path.dirname(__file__), "test_scenario_pool.json")

# 运行时状态位置：repo-local 的 temp/（.gitignore 已覆盖），每个 checkout 独立。
# - consumed.json: 已消费场景 id 记录 [{id, consumed_at, consumed_by}]
# - archive.json:  已消费场景完整归档
# corpus 文件（DEFAULT_POOL_PATH）只在 topup 补充新场景时写入，consume 永不修改它。
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RUNTIME_STATE_DIR = os.path.join(REPO_ROOT, "temp", "scenario_pool")
CONSUMED_PATH = os.path.join(RUNTIME_STATE_DIR, "consumed.json")
RUNTIME_ARCHIVE_PATH = os.path.join(RUNTIME_STATE_DIR, "archive.json")
# 兼容旧名：默认归档路径即运行时归档（git-ignored）
DEFAULT_ARCHIVE_PATH = RUNTIME_ARCHIVE_PATH


def is_corpus_path(pool_path):
    """判断给定路径是否为 git 跟踪的静态 corpus。corpus 走运行时状态语义，
    其他显式路径（如测试用的临时文件）保持传统的直接改文件语义。"""
    return os.path.abspath(pool_path) == os.path.abspath(DEFAULT_POOL_PATH)


def _ensure_runtime_dir():
    os.makedirs(RUNTIME_STATE_DIR, exist_ok=True)


def load_consumed_records():
    return load_json_file(CONSUMED_PATH, [])


def load_consumed_ids():
    return {r["id"] for r in load_consumed_records() if r.get("id")}


def get_effective_pool(pool_path=DEFAULT_POOL_PATH):
    """有效场景池 = corpus - 已消费（保持 corpus 顺序）。非 corpus 路径直接返回文件内容。"""
    items = load_json_file(pool_path, [])
    if not is_corpus_path(pool_path):
        return items
    consumed = load_consumed_ids()
    if not consumed:
        return items
    return [s for s in items if s.get("id") not in consumed]


def record_consumption(selected, consumed_by):
    """记录消费：只写 git-ignored 的运行时状态，不碰 corpus 文件。"""
    _ensure_runtime_dir()
    iso_now = datetime.now().isoformat()
    records = load_consumed_records()
    archive = load_json_file(RUNTIME_ARCHIVE_PATH, [])
    for s in selected:
        records.append({"id": s.get("id"), "consumed_at": iso_now, "consumed_by": consumed_by})
        item = dict(s)
        item["consumed_at"] = iso_now
        item["consumed_by"] = consumed_by
        archive.append(item)
    save_json_file(CONSUMED_PATH, records)
    save_json_file(RUNTIME_ARCHIVE_PATH, archive)


def load_json_file(path, default=None):
    if not os.path.isfile(path):
        return default if default is not None else []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ 读取 JSON 文件失败 {path}: {e}")
        return default if default is not None else []


def save_json_file(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_pool_status(pool_path=DEFAULT_POOL_PATH):
    scenarios = get_effective_pool(pool_path)
    domains = {}
    features = {}
    has_imagen = 0

    for s in scenarios:
        dom = s.get("domain", "unknown")
        domains[dom] = domains.get(dom, 0) + 1
        feats = s.get("features", [])
        if "imagen" in feats:
            has_imagen += 1
        for f in feats:
            features[f] = features.get(f, 0) + 1

    count = len(scenarios)
    deficit = max(0, TARGET_POOL_SIZE - count)
    is_healthy = count >= TARGET_POOL_SIZE and has_imagen >= 2

    return {
        "count": count,
        "target": TARGET_POOL_SIZE,
        "deficit": deficit,
        "is_healthy": is_healthy,
        "has_imagen": has_imagen,
        "domains": domains,
        "features": features,
        "scenarios": scenarios
    }


def validate_scenario(s, existing_ids=None):
    if not isinstance(s, dict):
        return False, "场景必须为字典对象"
    for req in ["id", "title", "domain", "features", "turns"]:
        if req not in s:
            return False, f"缺少必要字段: '{req}'"
    if not isinstance(s["id"], str) or not s["id"].strip():
        return False, "字段 'id' 必须为非空字符串"
    if existing_ids and s["id"] in existing_ids:
        return False, f"重复的场景 ID: '{s['id']}'"
    if not isinstance(s["turns"], list) or len(s["turns"]) < 2:
        return False, "字段 'turns' 必须包含至少 2 轮对话"
    for idx, t in enumerate(s["turns"]):
        if not isinstance(t, str) or not t.strip():
            return False, f"第 {idx+1} 轮对话内容不能为空"
    return True, ""


def validate_pool(pool_path=DEFAULT_POOL_PATH, strict_count=True):
    status = get_pool_status(pool_path)
    errors = []
    seen_ids = set()

    for idx, s in enumerate(status["scenarios"]):
        ok, err = validate_scenario(s, existing_ids=seen_ids)
        if not ok:
            errors.append(f"场景 [{idx}] ({s.get('id', '未知')}): {err}")
        else:
            seen_ids.add(s["id"])

    if strict_count and status["count"] < TARGET_POOL_SIZE:
        errors.append(f"场景池水位不足: 当前 {status['count']}/{TARGET_POOL_SIZE}，尚缺 {status['deficit']} 个场景")

    if status["has_imagen"] < 2:
        errors.append(f"包含 'imagen' 生图特性的场景过少 (当前仅 {status['has_imagen']} 个，需至少 2 个)")

    return len(errors) == 0, errors, status


def _select_scenarios(pool, count, require_imagen=True):
    """从 pool 列表中按策略选取 count 个，返回 (selected, remaining)。不落盘。"""
    pool = list(pool)
    selected = []
    # 策略：如果 require_imagen 且尚未选入，优先挑 1 个含 imagen 特性的场景
    if require_imagen:
        img_cand_idx = next((i for i, s in enumerate(pool) if "imagen" in s.get("features", [])), None)
        if img_cand_idx is not None:
            selected.append(pool.pop(img_cand_idx))

    # 其余名额按顺序从池中抽取
    while len(selected) < count and pool:
        selected.append(pool.pop(0))
    return selected, pool


def consume_scenarios(pool_path=DEFAULT_POOL_PATH, count=2, archive_path=DEFAULT_ARCHIVE_PATH, dry_run=False, require_imagen=True):
    """消费场景。

    corpus 路径（默认）：运行时状态语义——corpus 文件永不被修改，消费记录写入
    temp/scenario_pool/（git-ignored）；archive_path 参数此时被忽略，归档走运行时归档。
    显式路径（如测试临时文件）：传统语义——直接从该文件扣减并写入指定 archive 文件。
    """
    pool = get_effective_pool(pool_path)
    if len(pool) < count:
        raise ValueError(f"场景池数量不足！当前仅剩 {len(pool)} 个，请求消费 {count} 个。请先运行 manage_scenario_pool.py topup 进行补充！")

    selected, remaining = _select_scenarios(pool, count, require_imagen)

    if not dry_run:
        if is_corpus_path(pool_path):
            record_consumption(selected, consumed_by="manage_scenario_pool")
        else:
            save_json_file(pool_path, remaining)
            archive = load_json_file(archive_path, [])
            iso_now = datetime.now().isoformat()
            for s in selected:
                archived_item = dict(s)
                archived_item["consumed_at"] = iso_now
                archive.append(archived_item)
            save_json_file(archive_path, archive)

    return selected, remaining


def topup_scenarios(new_scenarios, pool_path=DEFAULT_POOL_PATH):
    """补充新场景。

    corpus 路径（默认）：新场景写入被 git 跟踪的 corpus（有意的 content 变更，随 PR 提交）；
    同时把已消费场景从 corpus 中修剪掉（其历史保留在运行时归档里），并清空已消费记录，
    使 corpus 保持在 TARGET_POOL_SIZE 附近——与旧流程"消费扣减、补充回满"的稳态一致。
    显式路径：传统语义，直接追加到该文件。
    """
    pool = load_json_file(pool_path, [])
    seen_ids = {s["id"] for s in pool if "id" in s}
    added = []

    for s in new_scenarios:
        ok, err = validate_scenario(s, existing_ids=seen_ids)
        if not ok:
            print(f"⚠️ 跳过不合规场景: {err}")
            continue
        pool.append(s)
        seen_ids.add(s["id"])
        added.append(s)

    if is_corpus_path(pool_path):
        consumed_ids = load_consumed_ids()
        if consumed_ids:
            pool = [s for s in pool if s.get("id") not in consumed_ids]
            save_json_file(CONSUMED_PATH, [])

    save_json_file(pool_path, pool)
    return added, pool


def print_status(pool_path=DEFAULT_POOL_PATH):
    status = get_pool_status(pool_path)
    print("=" * 60)
    print("📊 Gemini Exporter — 动态测试场景池运行状态")
    print("=" * 60)
    status_icon = "🟢 正常" if status["is_healthy"] else "🟡 需补齐"
    print(f"池容量状态: {status['count']} / {status['target']} (状态: {status_icon})")
    print(f"Imagen 生图用例: {status['has_imagen']} 个")
    if is_corpus_path(pool_path):
        consumed = load_consumed_records()
        print(f"运行时状态: {RUNTIME_STATE_DIR} (git-ignored)")
        print(f"本轮已消费: {len(consumed)} 个")
    if status["deficit"] > 0:
        print(f"⚠️ 缺口提示: 尚需补齐 {status['deficit']} 个多模态场景至 20 题满额")

    print("\n📂 覆盖领域分布 (Domains):")
    for d, c in sorted(status["domains"].items(), key=lambda x: -x[1]):
        print(f"  • {d:<26}: {c} 个")

    print("\n🏷️ 测试特性覆盖 (Features):")
    for f, c in sorted(status["features"].items(), key=lambda x: -x[1]):
        print(f"  • {f:<26}: {c} 个")

    print("\n📋 场景列表概览:")
    for idx, s in enumerate(status["scenarios"]):
        feats = ",".join(s.get("features", []))
        turns_cnt = len(s.get("turns", []))
        print(f"  [{idx+1:02d}] {s.get('id'):<32} | {s.get('title')[:18]:<18} | {turns_cnt} 轮 | [{feats}]")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Gemini Exporter 测试场景池管理器")
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    subparsers.add_parser("status", help="显示场景池当前水位与领域特征分布")
    
    val_p = subparsers.add_parser("validate", help="校验场景池合规性与水位")
    val_p.add_argument("--allow-below-target", action="store_true", help="允许水位低于 20 (仅校验数据格式完整性)")

    con_p = subparsers.add_parser("consume", help="消费测试场景并自动归档")
    con_p.add_argument("--count", type=int, default=2, help="消费场景数量 (默认 2)")
    con_p.add_argument("--dry-run", action="store_true", help="演练模式，不落盘修改")

    top_p = subparsers.add_parser("topup", help="从 JSON 文件补齐新场景")
    top_p.add_argument("--file", required=True, help="待添加的新场景 JSON 文件路径")

    subparsers.add_parser("archive", help="查看历史被消费场景归档")

    args = parser.parse_args()

    if args.command == "status" or args.command is None:
        print_status()
    elif args.command == "validate":
        ok, errs, st = validate_pool(strict_count=not args.allow_below_target)
        if ok:
            print(f"✅ 场景池校验全部通过！当前容量: {st['count']}/{st['target']}，特征分布健全。")
            sys.exit(0)
        else:
            print(f"❌ 场景池校验发现 {len(errs)} 处问题:")
            for e in errs:
                print(f"  • {e}")
            sys.exit(1)
    elif args.command == "consume":
        try:
            selected, remaining = consume_scenarios(count=args.count, dry_run=args.dry_run)
            mode_str = "[DRY-RUN 演练] " if args.dry_run else ""
            print(f"🎉 {mode_str}成功消费 {len(selected)} 个场景：")
            for s in selected:
                print(f"  - [{s.get('id')}] {s.get('title')} ({len(s.get('turns', []))} 轮, 特性: {s.get('features')})")
            print(f"💡 场景池当前剩余: {len(remaining)}/{TARGET_POOL_SIZE}")
            if len(remaining) < TARGET_POOL_SIZE:
                print(f"📌 提示: 请在下次提交 PR 前由 AI 助手或通过 `manage_scenario_pool.py topup` 补回至 20 个！")
        except Exception as e:
            print(f"❌ 消费失败: {e}")
            sys.exit(1)
    elif args.command == "topup":
        scenarios = load_json_file(args.file)
        if not scenarios:
            print(f"❌ 未在 {args.file} 读取到场景数组")
            sys.exit(1)
        added, pool = topup_scenarios(scenarios)
        print(f"✅ 成功补齐 {len(added)} 个场景！当前场景池总数: {len(pool)}/{TARGET_POOL_SIZE}")
    elif args.command == "archive":
        archive = load_json_file(RUNTIME_ARCHIVE_PATH, [])
        print(f"📚 历史归档场景总数: {len(archive)} 个 (运行时状态: {RUNTIME_STATE_DIR})")
        for idx, item in enumerate(archive[-10:]):
            print(f"  [{idx+1}] {item.get('consumed_at', '未知时间')}: {item.get('title')} ({item.get('id')})")


if __name__ == "__main__":
    main()
