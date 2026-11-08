#!/usr/bin/env python3
"""Generate the long-conversation parity fixture (default 121 messages).

Deterministic (seeded) so the committed JSON is reproducible. The fixture is
NOT hand-written: regenerate with
    python3 generate_long_conversation.py --messages 121 --out long-conversation-121.json

Every message carries a unique message id, source array order, and
mixed Chinese/English content so the HTML/PDF parity harness has realistic
long-document material (page breaks, repeated headings, mid-document tables
and code blocks).
"""
import argparse
import json
import random

USER_TEMPLATES = [
    "第 {n} 轮：请解释一下增量同步里「上次扫描的最大时间戳」作为停止条件的含义。",
    "Round {n}: how is message order preserved during export?",
    "第 {n} 轮：如果导出中途用户取消了，失败的条目应该怎么标记？",
    "Round {n}: compare the trade-offs of bundling CJK fonts vs local-first loading.",
    "第 {n} 轮：表格超过一页时，表头应该怎么处理？",
]

ASSISTANT_TEMPLATES = [
    "第 {n} 轮回答：停止条件以「上次扫描的最大时间戳」为准——扫描按时间倒序进行，"
    "一旦遇到更新时间早于（或等于）该时间戳且内容未变更的记录即停止，保证增量扫描收敛。",

    "Round {n} answer: messages are exported in source array order. "
    "The message array is the sole authoritative order.",

    "第 {n} 轮回答：取消是协作式的——导出循环每次迭代检查取消标志；"
    "已标记失败的条目保持 {{failed}} 状态并可重试，绝不能被标成成功。",

    "Round {n} answer: bundling CJK fonts makes PDFs self-contained but adds "
    "~15MB per export; local-first keeps the bundle small and reuses system fonts, "
    "at the cost of machine-dependent rendering. P0 chose local-first.",

    "第 {n} 轮回答：跨页表格应在每一页重复表头行；Typst 与 HTML 打印都支持 "
    "`repeat-header` 语义，parity 对比时以「每页首行是否为表头」作为断言。",
]


def text(t):
    return {"type": "text", "text": t}


def strong(t):
    return {"type": "strong", "children": [text(t)]}


def emphasis(t):
    return {"type": "emphasis", "children": [text(t)]}


def paragraph(*children):
    return {"type": "paragraph", "children": list(children)}


def build_message(idx, role, rng):
    """idx is 1-based. Returns a DisplayMessage dict."""
    mid = f"{'u' if role == 'user' else 'a'}{idx}"
    tpl = rng.choice(USER_TEMPLATES if role == "user" else ASSISTANT_TEMPLATES)
    n = (idx + 1) // 2  # round number
    blocks = [paragraph(text(tpl.format(n=n)))]
    # Sprinkle block variety deterministically so the long fixture exercises
    # more than plain paragraphs.
    if role == "assistant" and idx % 10 == 0:
        blocks.append({
            "type": "code", "language": "python",
            "code": f"def round_{n}():\n    return 'parity-check-{n}'\n",
        })
    if role == "assistant" and idx % 15 == 0:
        blocks.append({
            "type": "table",
            "columnAlignments": ["left", "right"],
            "headerRows": [[
                {"children": [text("指标")], "column": 0, "colSpan": 1, "rowSpan": 1},
                {"children": [text("第 %d 轮" % n)], "column": 1, "colSpan": 1, "rowSpan": 1},
            ]],
            "rows": [[
                {"children": [text("消息数")], "column": 0, "colSpan": 1, "rowSpan": 1},
                {"children": [text(str(idx))], "column": 1, "colSpan": 1, "rowSpan": 1},
            ]],
        })
    if role == "assistant" and idx % 21 == 0:
        blocks.append({
            "type": "math",
            "source": r"\sum_{i=1}^{%d} i = %d" % (n, n * (n + 1) // 2),
        })
    if role == "user" and idx % 7 == 0:
        blocks.append(paragraph(
            emphasis("补充："), text("这一轮还请覆盖 "),
            strong("中英文混排"), text(" 与 "),
            {"type": "inlineCode", "code": f"round_{n}"}, text(" 的行内代码。"),
        ))
    msg = {
        "id": mid,
        "type": "message",
        "label": "you" if role == "user" else "assistant",
        "variant": "bubble" if role == "user" else "flow",
        "blocks": blocks,
    }
    return msg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--messages", type=int, default=121)
    ap.add_argument("--seed", type=int, default=20260926)
    ap.add_argument("--out", default="long-conversation-121.json")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    messages = []
    user_i = 0
    asst_i = 0
    for i in range(args.messages):
        role = "user" if i % 2 == 0 else "assistant"
        if role == "user":
            user_i += 1
            idx = user_i
        else:
            asst_i += 1
            idx = asst_i
        msg = build_message(idx, role, rng)
        messages.append(msg)

    fixture = {
        "document": {
            "schemaVersion": 2,
            "metadata": {"id": "long-conversation-121", "provider": "gemini"},
            "header": {"title": "长会话：121 消息 parity 语料", "providerLabel": "gemini", "date": "2026-09-26", "messageCount": len(messages)},
            "messages": messages,
        },
        "resourceIds": [],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
    print(f"wrote {args.out}: {len(messages)} messages, "
          f"{sum(len(m['blocks']) for m in messages)} blocks")


if __name__ == "__main__":
    main()
