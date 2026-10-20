# AI 助手与自动化协作指南 (AI Agent Guide & Rules)

## 产品身份与设计基线 (Product Identity & Design Baseline)

- 产品名称是 **AI Exporter**。
- **原始 Gemini Exporter 的视觉设计、Workbench 布局、交互模型和整体 UX 是本项目的设计基线与默认规范。**
- ChatGPT 以及未来其他 AI provider 必须被集成进这套既有设计语言；除非有明确的可用性/无障碍/安全原因并有测试证据，否则不得因为“多 provider”而重新设计整个产品。
- Gemini 仍然是必须保持零回归的稳定基线 provider。新增 provider 不能通过破坏、替换或弱化原 Gemini Exporter 工作流来实现。
- 面向用户的通用产品文案使用 **AI Exporter**；仅在说明某个 provider 的专属功能时使用 **Gemini**、**ChatGPT** 等 provider 名称。
- 任何声称 ChatGPT 或其他 provider “完整支持”的变更，都必须满足对应 inventory、raw capture、assets、integrity/completeness 与 live regression gate，而不能只依据单个 Markdown 导出成功。


本文件为所有协助开发与维护本项目（Gemini Exporter）的 AI Agent（包括 Antigravity、Claude Code、Cursor、Copilot、Codex 等）提供统一规范与操作准则。

---

## 一、核心工作流原则 (Core Principles)

1. **本地核心代码永远保持 main 的最新状态**：
   - 本地仓库主目录（Core Repo）始终停留在 `main` 分支并保持与远端最新状态同步。
   - 严禁在本地主目录的 `main` 分支上直接修改、提交或开发业务代码。

2. **使用 Git Worktree 进行功能迭代**：
   - 所有的功能开发、Bug 修复、重构与测试，必须基于 `main` 通过 `git worktree` 创建一个干净的独立工作副本和对应的新分支（如 `feature/...`、`fix/...`、`docs/...`）。
   - 在 worktree 中进行编码、测试与本地提交。

3. **严禁直接 Push 到 main，通过 PR + 自动合并 (Auto-Merge) 流程**：
   - **绝对禁止直接 push 到 `main` 分支**。
   - 开发与测试验证完成后，将特性分支推送到远程仓库并创建 Pull Request：
     ```bash
     gh pr create --base main --title "..." --body "..."
     ```
   - **全自动 CI 门禁与合并（0 人工介入）**：创建 PR 后立即启用 GitHub 服务端 Auto-Merge：
     ```bash
     gh pr merge --auto --squash --delete-branch
     ```
     GitHub 服务端会自动挂起，待门禁 CI（`Unit Tests & Syntax`、`Playwright E2E Tests`、`CodeQL`）全绿通过后自动 Squash Merge 并删除远程分支，无需任何人工审批或手动点击。
   - PR 自动合并完成后，清理本地 worktree 副本与临时分支，并在主目录执行 `git pull --ff-only` 保持与 `main` 最新同步。

---

## 二、三层测试体系规范 (Three-Tier Testing Architecture)

本项目严格区分并建立了双层测试体系，任何 AI 在提交代码或宣称功能完成前，必须严格依照下述标准执行验证：

### 第一层：CI 自动化门禁测试 (Tier 1: Fast & Headless)
* **执行命令**：
  - **全量门禁**：`npm test`（对应 `npm run type-check && python3 tests/run_tests.py && node build.js && playwright test`）。
  - **增量极速（推荐日常开发使用）**：`npm run test:changed`（基于 Git 差异进行**模块级反向依赖分析与传递闭包推导 (Transitive Impact Analysis)**，若修改底层依赖则自动递归追溯并运行所有直接与间接关联模块及对应 Playwright 规格，耗时仅 5~15 秒）。
  - **影响分析报告**：`npm run test:impact`（打印当前改动对全仓模块与测试的传递影响拓扑）。
  - **单点定向单元测试**：`python3 tests/run_tests.py --filter <keyword>`（如 `python3 tests/run_tests.py --filter storage`，秒级验证指定模块）。
* **适用场景**：日常功能开发与单步迭代推荐使用 `npm run test:changed` 极速自测；每次提交 PR 前必须全量通过 `npm test`，GitHub Actions 门禁对此强制校验。
* **特性**：轻量极速，包含 TypeScript 严格类型检查、103 个单元测试套件、esbuild 生产 Bundle 打包构建校验与 39 个无头 Playwright 端到端用例（含 1:1 HTML 导出、老会话置顶升权、会话实时删除与 Takeout 标题升级视觉审计），完全自包含，不依赖外网与真实 Google 账号。

### 第二层：真实调试 Chrome 全流程实跑测试 (Tier 2: Live Debug Staging)
* **执行命令**：`npm run test:live`（对应 `python3 scripts/test_live_chat_and_export.py`）。
* **适用场景**：修改了 Protobuf/JSPB 解析引擎、Google Takeout 导入逻辑、会话排序、网络请求拦截或发布新版本前。
* **环境准备**：需先通过 `./scripts/open_test_chrome.sh`（Windows 环境运行 `.\scripts\open_test_chrome.ps1` 或 `.\scripts\open_test_chrome.cmd`）启动开启 9222 调试端口的独立 Chrome 并登录测试账号。
* **运行模式与场景调度机制**：
  * **统一标准模式：动态 20 题多模态场景池机制（默认行为）**：
    1. 项目在 `scripts/test_scenario_pool.json` 维护了 20 个覆盖 10+ 领域的高价值测试场景（包含 AI 图像生成、LaTeX 公式、Markdown 表格、多语言混排、长代码等全模态特性）；
    2. 运行 `npm run test:live`（或 `npm run test:live:pool`），自动从池中出队消费 2 个最新场景（1 个含 Imagen 生图，1 个长文本深度推演），消费记录与归档写入 `temp/scenario_pool/`（git-ignored），corpus 文件本身不被修改；
    3. **AI 补仓铁律（用 2 补 2，常驻 20 题）**：AI 助手在协同开发、跑测试或提交 PR 前，必须运行 `npm run pool:status` 检查水位。若水位低于 20 个，必须针对当前缺口领域构思全新多模态题材补充回 20 题，杜绝同一题材（如深空探测器）反复堆积。
  * **自定义外挂数据集模式 (`--dataset`)**：
    - 支持通过 `--dataset <path>` 传入自定义的 JSON 测试用例文件，执行器将直接加载并运行该数据集。

  * **通用验收铁律（四大不可逾越标准）**：
    1. **全流程全特性强制闭环（物理禁止跳过）**：必须真实驱动 Gemini 发帖并等待全部流式回复物理落地；所有测试阶段（扩展重装、新手向导、实时发帖、老会话追加置顶、瞬态删除清理、Takeout 合流导入与 6 会话联合规范导出）强制 100% 完整闭环执行，测试脚本已物理移除所有跳过开关（如 `--skip-chat`、`--skip-takeout`、`--skip-reinstall`、`--skip-tour`），严禁任何形式的绕过或缩水；
    2. **必须实际检验导出 Markdown 文件内容（严禁仅凭内存判断）**：测试脚本会自动将导出的 ZIP 下载到磁盘并解压，必须逐字核对会话 1 全部 5 轮与会话 2 全部 8 轮提问与回答在 Markdown 中 100% 物理存在；
    3. **必须校验老会话追加提问实时置顶、Google Takeout 离线导入与全量历史合流及网页端瞬态实时删除会话清理**：
       - **老会话实时置顶升权 (Stage 2.5)**：会话 2 生成完毕后，测试流自动回访较早创建的会话 1 并发送追加提问，检验流式生成完毕后通过 `STREAM_COMPLETE` 实时更新 `updatedAt`/`timestamp`，并在 Options 工作台中无需刷新即自动提升至列表首位（高于会话 2）；
       - **Takeout 离线合流**：测试流会自动读取预置的 `tests/fixtures/gemini_takeout_clean.zip`，检验离线导入初始提问前缀临时标题（`titleSource: takeout`），随后触发【全量拉取历史】(`btnDeepScan`) 地毯式分页同步所有云端历史，核实 Takeout 临时标题被在线 RPC 权威升级覆盖（`titleSource: rpc`）；
       - **瞬态自毁会话实时清理**：通过【瞬态自毁会话】(Live Ephemeral Chat) 真实验证网页端删除时通过 RPC 拦截与消息桥接在无需刷新的情况下实时剥离本地 Storage 与 Options DOM 列表，且绝不误伤有效会话与离线 Takeout 存档；
    4. **必须通过多模态联合导出规范断言**：当次导出会精准联合勾选 2 个现场新问答会话 + 4 种指定核心分类历史会话（AI Imagen 生图、Python 高质量代码块、Markdown 量子对比表格、深空探测长文本报告），解压后逐一核验新会话 100% 物理轮次及 4 大类别黄金语法特征与物理附件落地（索引文件、YAML Frontmatter 7 键闭合、角色交替与时间戳、0 遥测噪点、图片附件实体非空、AI Imagen 生成图模型归属断言）。

---

### 第三层：纯视觉 AI 盲测与 UI 质检体系 (Tier 3: Pure Visual Playground & Autonomous QA Agent)
* **架构定位**：Tier 3 采用**纯截屏感知（0 DOM 树泄露）**与硬件级鼠标/键盘物理驱动，复用 Tier 2 的确定性阻塞挂起机制，提供黑盒环境下的自主 UI 体验体检与 AI 协作靶场。**已物理彻底删除所有硬编码坐标与假 exit-0 捷径**，仅支持且必须通过两大途径执行：
  - **途径一：无 Context 子智能体自主探索 (Subagent Mode, 首选推荐)**：宿主 Agent 通过 `invoke_subagent` 拉起一个无上下文历史污染的子智能体，由子智能体基于纯视觉截屏在黑盒环境中自主探索；
  - **途径二：自定义 / 第三方 AI 接口驱动 (Custom AI API Mode)**：通过 `CustomAIVisionProvider` 连接兼容 OpenAI 或自建多模态端点，由外部大模型驱动 `AutonomousVisualAgent` 自动推演。
* **《Tier 3 AI 助手纯视觉执行铁律》**：
  1. **严禁凭空写死坐标或伪造退出**：所有 `--smoke`、硬编码坐标点击等捷径已物理删除，严禁任何 AI 助手以静态点击或假 exit 0 冒充 Tier 3 测试；
  2. **宿主 Agent 必须通过 `invoke_subagent` 拉起无 Context 子智能体**：当宿主 Agent（如 Antigravity）被指派执行 Tier 3 视觉体检任务时，**必须开启一个全新无历史上下文污染的子智能体 (`Tier 3 Visual QA Explorer`)**；
  3. **受测智能体严格隔离于 7 大受控 CLI 接口**：受测子智能体只能且仅能调用 `scripts/visual_agent/cli.py` 的 7 大原语（`screenshot`, `click`, `type`, `scroll`, `wait-on`, `reset`, `evaluate-export`），0 DOM 泄露，严禁直接注入 JS 或查询 DOM 树选择器；
  4. **必须以纯视觉截屏闭环推演并真实产出 Scorecard 与 HTML 审计报告**（保存于 `tests/output/visual_audit/` 目录）。

---

## 三、常用辅助命令速查

```bash
# 运行 Tier 1 依赖感知增量测试 (极速 5~15s，日常开发首选)
npm run test:changed

# 查看当前改动的影响拓扑与受影响测试清单
npm run test:impact

# 定向过滤运行特定单元测试 (秒级完成，如仅测 storage)
python3 tests/run_tests.py --filter storage

# 启动独立调试环境 Chrome (端口 9222)
./scripts/open_test_chrome.sh          # macOS / Linux
.\scripts\open_test_chrome.ps1         # Windows PowerShell
.\scripts\open_test_chrome.cmd         # Windows CMD

# 查看场景池当前水位与领域特征分布
npm run pool:status

# 运行全量实跑测试 (标准模式：从 20 题场景池消费 2 个最新多模态场景)
npm run test:live
# 或: python3 scripts/test_live_chat_and_export.py

# 运行自定义外挂数据集测试
python3 scripts/test_live_chat_and_export.py --dataset <path_to_custom_dataset.json>

# 单独对任意导出解压目录运行规范断言器
python3 tests/helpers/export_spec_asserter.py <解压目录路径>

# 途径一：就绪交互靶场 (供人类或无 Context 子智能体 Subagent 探索)
npm run test:visual
# 或: python3 scripts/test_visual_agent.py --playground [--target options|popup|gemini]

# 途径二：通过自定义 AI 接口驱动自主推演
npm run test:visual:custom -- --endpoint <url> [--goal "<目标>"]
# 或: python3 scripts/test_visual_agent.py --api --endpoint <url> [--ai-review]
```


