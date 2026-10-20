# Parity Corpus（HTML/PDF 文本对比语料）

Phase F §17：HTML canonical renderer（#552）与 Phase D 真编译器都落地后，
`tests/pdf-parity-corpus.test.ts` 的 skip 测试将逐 fixture 做 HTML-vs-PDF
归一化文本对比。这些 fixture 就是对比的输入语料。

## Fixture 一览

| 文件 | 内容 | 消息数 |
|---|---|---|
| `math-cjk.json` | 公式 + 中文：行内公式、display 公式、引用组 | 2 |
| `long-table.json` | 长表格：15 行 × 5 列，中英混排 + 数字列多对齐 | 2 |
| `code-block.json` | 代码块：python / typescript / bash + 引用 + 行内代码 | 2 |
| `quote-group.json` | 引用组：嵌套引用、有序/无序列表、thought、分隔线 | 2 |
| `image-attachment.json` | 图片/附件占位：行内图 + 独立图块 + 文件块（asset 为 `missing` 占位，无 bytes） | 2 |
| `long-conversation-121.json` | 121 消息长会话（程序化生成，见下） | 121 |

## 生成方式

- 前 5 个为手工编写的 JSON（内容型 fixture，手工写更易读）。
- `long-conversation-121.json` 由 `generate_long_conversation.py` 生成（seed 固定，可复现）：
  `python3 generate_long_conversation.py --messages 121 --out long-conversation-121.json`
- 改动任一 fixture 后，`tests/pdf-parity-corpus.test.ts` 的两个激活测试会校验：
  canonical runtime validator 零 error/warning + 版本化 JSON Schema 合规。

## 启用 skip 的 HTML-vs-PDF 对比

前置条件（测试文件内有同样注释）：#552 合入 + Phase D 真编译器落地。
启用方式：把 `test.skip(...)` 改回 `test(...)` 并填入真实的 render/compile 调用。
