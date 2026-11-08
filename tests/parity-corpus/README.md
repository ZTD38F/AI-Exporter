# Parity Corpus（HTML/PDF 文本对比语料）

固定语料只保存共享 Document AST 和独立资源 ID。测试直接比较 HTML 与 PDF transport 的归一化可见文本，并验证 JSON 往返、消息顺序、资源引用和缺失资源诊断。加载时将完整 JSON 作为新鲜字面量交给项目编译器，严格按当前 `DocumentAst` 定义验证所有层级；多余字段（如已废弃的 `anchor`）、缺失字段和错误类型均会失败。

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
- 改动 fixture 后运行 `tests/pdf-parity-corpus.test.ts`，验证结构闭合、消息顺序和双向文本保真。

本次迁移从旧 composer 一次性冻结共享 Document AST，后端测试不再保留 Canonical 数据或运行时转换器。
