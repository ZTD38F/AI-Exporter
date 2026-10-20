# scripts/visual_agent/cli.py
"""
Gemini Exporter — Visual Playground CLI Interface.
Enables any AI Agent or human operator to interact directly with the Visual Playground:
- screenshot: capture current viewport
- click: dispatch hardware mouse click at normalized (x, y)
- type: dispatch hardware keyboard input at (x, y)
- scroll: dispatch hardware wheel scroll
- wait-on: blocking deterministic wait (stream_settled, zip_downloaded, ui_idle, dom_pruned)
- reset: reset environment to initial state
- evaluate-export: verify exported ZIP against specification
"""

import os
import sys
import argparse
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from scripts.visual_agent.playground import open_visual_playground


def main():
    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument("--port", type=int, default=9222, help="CDP debug port (default: 9222)")
    common_parser.add_argument("--target", type=str, default=None, choices=["options", "gemini", "chat", "workbench", "popup"], help="Target page (default: auto-detect from active state)")
    common_parser.add_argument("--json", action="store_true", help="Output result in structured JSON format")

    parser = argparse.ArgumentParser(description="Gemini Exporter Visual Playground CLI", parents=[common_parser])
    subparsers = parser.add_subparsers(dest="command", help="Playground command")

    # 1. screenshot
    p_shot = subparsers.add_parser("screenshot", help="Capture screen", parents=[common_parser])
    p_shot.add_argument("--name", type=str, default=None, help="Optional step name for the screenshot")

    # 2. click
    p_click = subparsers.add_parser("click", help="Physical mouse click", parents=[common_parser])
    p_click.add_argument("--x", type=float, required=True, help="Normalized X coordinate (0.0 - 1.0)")
    p_click.add_argument("--y", type=float, required=True, help="Normalized Y coordinate (0.0 - 1.0)")
    p_click.add_argument("--button", type=str, default="left", choices=["left", "right"], help="Mouse button")

    # 3. type
    p_type = subparsers.add_parser("type", help="Physical keyboard input", parents=[common_parser])
    p_type.add_argument("--text", type=str, required=True, help="Text to type")
    p_type.add_argument("--x", type=float, default=None, help="Optional click X to focus")
    p_type.add_argument("--y", type=float, default=None, help="Optional click Y to focus")
    p_type.add_argument("--no-clear", action="store_true", help="Do not clear existing input first")

    # 4. scroll
    p_scroll = subparsers.add_parser("scroll", help="Physical mouse wheel", parents=[common_parser])
    p_scroll.add_argument("--delta", type=int, default=300, help="Scroll delta Y in pixels")
    p_scroll.add_argument("--x", type=float, default=0.5, help="Normalized X coordinate (default: 0.5)")
    p_scroll.add_argument("--y", type=float, default=0.5, help="Normalized Y coordinate (default: 0.5)")

    # 5. wait-on
    p_wait = subparsers.add_parser("wait-on", help="Deterministic blocking wait", parents=[common_parser])
    p_wait.add_argument("--condition", type=str, required=True, help="Condition to await: stream_settled, zip_downloaded, ui_idle, dom_pruned")
    p_wait.add_argument("--timeout", type=int, default=120, help="Timeout in seconds")
    p_wait.add_argument("--chat-id", type=str, default="", help="Chat ID for dom_pruned condition")
    p_wait.add_argument("--min-mtime", type=float, default=0.0, help="Min mtime for zip_downloaded condition")

    # 6. switch-page
    p_switch = subparsers.add_parser("switch-page", help="Switch active page / tab silently in background", parents=[common_parser])
    p_switch.add_argument("--to", dest="switch_to", required=True, choices=["options", "gemini", "chat", "workbench"], help="Target page to switch to")
    p_switch.add_argument("--chat", dest="chat_id", default=None, help="Optional Gemini conversation ID (e.g. c_xxx or xxx)")
    p_switch.add_argument("--new", action="store_true", help="Start a clean new conversation on Gemini (navigates to /app and resets input)")
    p_switch.add_argument("--bring-to-front", action="store_true", help="Physically bring Chrome window to OS front (may steal OS desktop focus)")

    # 7. reset
    p_reset = subparsers.add_parser("reset", help="Reset environment to initial state", parents=[common_parser])
    p_reset.add_argument("--reinstall", action="store_true", help="Also cleanly reinstall extension from workspace")

    # 8. reinstall
    p_reinstall = subparsers.add_parser("reinstall", help="Cleanly reinstall extension from current workspace", parents=[common_parser])

    # 9. evaluate-export
    p_eval = subparsers.add_parser("evaluate-export", help="Evaluate exported ZIP file specification", parents=[common_parser])
    p_eval.add_argument("--zip", type=str, required=True, help="Path to ZIP file")
    p_eval.add_argument("--min", type=int, default=1, help="Expected minimum conversations (default: 1)")
    p_eval.add_argument("--chat-id", type=str, default=None, help="Target conversation ID to assert presence and validity")
    p_eval.add_argument("--require-golden", action="store_true", help="Assert presence and deep content of core test golden dataset")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "reinstall":
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
        from scripts.framework.environment import TestEnvironment
        env = TestEnvironment(port=args.port, repo_path=repo_root)
        ext_id = env.reinstall_extension()
        if ext_id:
            res = {"success": True, "action": "reinstall", "extension_id": ext_id}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(f"✅ 扩展已成功纯净重装！Extension ID: {ext_id}")
            sys.exit(0)
        else:
            res = {"success": False, "error": "Reinstall failed"}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print("❌ 扩展重装失败！")
            sys.exit(1)

    try:
        playground = open_visual_playground(port=args.port, target_page=args.target)
    except Exception as e:
        res = {"success": False, "error": str(e)}
        if args.json:
            print(json.dumps(res, ensure_ascii=False))
        else:
            print(f"❌ 无法连接 Visual Playground: {e}")
        sys.exit(1)

    try:
        if args.command == "screenshot":
            obs = playground.capture_screen(args.name)
            res = {
                "success": True,
                "file_path": obs.file_path,
                "viewport": list(obs.viewport),
                "timestamp": obs.timestamp
            }
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(f"📸 截屏成功: {obs.file_path}")

        elif args.command == "click":
            playground.mouse_click(args.x, args.y, button=args.button)
            res = {"success": True, "action": "click", "x": args.x, "y": args.y}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(f"🖱️ 点击成功 -> ({args.x:.3f}, {args.y:.3f})")

        elif args.command == "type":
            playground.input_text(args.text, x=args.x, y=args.y, clear_first=not args.no_clear)
            res = {"success": True, "action": "type", "text": args.text}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(f"⌨️ 键入成功 -> '{args.text}'")

        elif args.command == "scroll":
            playground.mouse_scroll(args.delta, x=args.x, y=args.y)
            res = {"success": True, "action": "scroll", "delta": args.delta}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(f"📜 滚轮成功 -> deltaY: {args.delta}")

        elif args.command == "wait-on":
            extra = {}
            if args.chat_id:
                extra["chat_id"] = args.chat_id
            if args.min_mtime:
                extra["min_mtime"] = args.min_mtime
            w_res = playground.wait_on(args.condition, timeout=args.timeout, **extra)
            res = {
                "success": w_res.success,
                "condition": args.condition,
                "message": w_res.message,
                "elapsed": w_res.elapsed,
                "data": w_res.data
            }
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                tag = "✓" if w_res.success else "❌"
                print(f"{tag} wait_on('{args.condition}'): {w_res.message} (耗时: {w_res.elapsed:.1f}s)")
            if not w_res.success:
                sys.exit(2)

        elif args.command == "switch-page":
            ok = playground.switch_page(
                target=args.switch_to,
                chat_id=args.chat_id,
                bring_to_front=args.bring_to_front,
                new_chat=args.new
            )
            res = {
                "success": ok,
                "action": "switch-page",
                "target": args.switch_to,
                "chat_id": args.chat_id,
                "new_chat": args.new,
                "bring_to_front": args.bring_to_front
            }
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                cid_str = f" (会话: {args.chat_id})" if args.chat_id else ""
                new_str = " (全新对话 /app)" if args.new else ""
                front_str = "，并已前置激活窗口" if args.bring_to_front else " (后台静默，无焦点抢占)"
                print(f"🔀 已成功切换活动标签页至: {args.switch_to}{new_str}{cid_str}{front_str}")

        elif args.command == "reset":
            target = args.target or "options"
            reinstall = getattr(args, "reinstall", False)
            playground.reset(target=target, reinstall=reinstall)
            res = {"success": True, "action": "reset", "target": target, "reinstalled": reinstall}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                reinstall_str = " (已执行纯净重装)" if reinstall else ""
                print(f"🔄 环境已重置至 {target}{reinstall_str}")

        elif args.command == "evaluate-export":
            golden_chats = None
            if args.require_golden:
                from scripts.framework.cases.export import DESIGNATED_HISTORICAL_CHATS
                golden_chats = DESIGNATED_HISTORICAL_CHATS
            ok, msg, details = playground.evaluate_export(
                zip_path=args.zip,
                min_conversations=args.min,
                expected_golden_chats=golden_chats,
                chat_id=args.chat_id
            )
            res = {"success": ok, "message": msg, "details": details}
            if args.json:
                print(json.dumps(res, ensure_ascii=False))
            else:
                tag = "✓" if ok else "❌"
                print(f"{tag} 导出断言: {msg}")
            if not ok:
                sys.exit(3)

    finally:
        playground.teardown()


if __name__ == "__main__":
    main()
