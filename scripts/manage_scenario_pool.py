#!/usr/bin/env python3
"""
scripts/manage_scenario_pool.py
---------------------------------
Gemini Exporter — 动态 20 题多模态测试场景池管理器。

实现规范：
1. 维护 20 个跨领域、多模态的高价值测试会话场景；
2. 每次实跑测试消费 2 个（1 个包含 Imagen 生图，1 个深度长文本），并自动归档至 scripts/test_scenario_archive.json；
3. 支持 status / validate / consume / topup / archive 等 CLI 指令；
4. AI 助手参与协作或提交 PR 前，必须将场景池补齐至 20 题。
"""

import sys
import os
import json
import time
import argparse
from datetime import datetime

TARGET_POOL_SIZE = 20
DEFAULT_POOL_PATH = os.path.join(os.path.dirname(__file__), "test_scenario_pool.json")
DEFAULT_ARCHIVE_PATH = os.path.join(os.path.dirname(__file__), "test_scenario_archive.json")


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
    scenarios = load_json_file(pool_path, [])
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


def consume_scenarios(pool_path=DEFAULT_POOL_PATH, count=2, archive_path=DEFAULT_ARCHIVE_PATH, dry_run=False, require_imagen=True):
    pool = load_json_file(pool_path, [])
    if len(pool) < count:
        raise ValueError(f"场景池数量不足！当前仅剩 {len(pool)} 个，请求消费 {count} 个。请先运行 manage_scenario_pool.py topup 进行补充！")

    selected = []
    # 策略：如果 require_imagen 且尚未选入，优先挑 1 个含 imagen 特性的场景
    if require_imagen:
        img_cand_idx = next((i for i, s in enumerate(pool) if "imagen" in s.get("features", [])), None)
        if img_cand_idx is not None:
            selected.append(pool.pop(img_cand_idx))

    # 其余名额按顺序从池中抽取
    while len(selected) < count and pool:
        selected.append(pool.pop(0))

    if not dry_run:
        save_json_file(pool_path, pool)
        archive = load_json_file(archive_path, [])
        iso_now = datetime.now().isoformat()
        for s in selected:
            archived_item = dict(s)
            archived_item["consumed_at"] = iso_now
            archive.append(archived_item)
        save_json_file(archive_path, archive)

    return selected, pool


def topup_scenarios(new_scenarios, pool_path=DEFAULT_POOL_PATH):
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
        archive = load_json_file(DEFAULT_ARCHIVE_PATH, [])
        print(f"📚 历史归档场景总数: {len(archive)} 个")
        for idx, item in enumerate(archive[-10:]):
            print(f"  [{idx+1}] {item.get('consumed_at', '未知时间')}: {item.get('title')} ({item.get('id')})")


if __name__ == "__main__":
    main()
