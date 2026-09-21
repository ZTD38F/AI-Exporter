# AI 助手与自动化协作指南 (AI Agent Guide & Rules)

本文件为所有协助开发与维护本项目（Gemini Exporter）的 AI Agent（包括 Antigravity、Claude Code、Cursor、Copilot、Codex 等）提供统一规范与操作准则。

---

## 一、核心工作流原则 (Core Principles)

1. **本地核心代码永远保持 main 的最新状态**：
   - 本地仓库主目录（Core Repo）始终停留在 `main` 分支并保持与远端最新状态同步。
   - 严禁在本地主目录的 `main` 分支上直接修改、提交或开发业务代码。

2. **使用 Git Worktree 进行功能迭代**：
   - 所有的功能开发、Bug 修复、重构与测试，必须基于 `main` 通过 `git worktree` 创建一个干净的独立工作副本和对应的新分支（如 `feature/...`、`fix/...`、`docs/...`）。
   - 在 worktree 中进行编码、测试与本地提交。

3. **严禁直接 Push 到 main，必须通过 PR 流程合并**：
   - **绝对禁止直接 push 到 `main` 分支**。
   - 开发与测试验证完成后，必须将特性分支推送到远程仓库，并通过 GitHub CLI (`gh pr create --base main`) 创建 Pull Request。
   - 待 CI 自动化校验通过并合并完成后，清理本地 worktree 副本与临时分支，并在主目录执行 `git pull --ff-only` 保持同步。

---

## 二、双层测试体系规范 (Two-Tier Testing Architecture)

本项目严格区分并建立了双层测试体系，任何 AI 在提交代码或宣称功能完成前，必须严格依照下述标准执行验证：

### 第一层：CI 自动化门禁测试 (Tier 1: Fast & Headless)
* **执行命令**：`npm test`（对应 `npm run type-check && python3 tests/run_tests.py && node build.js && playwright test`）。
* **适用场景**：每次提交 PR 前在本地 worktree 中必须全绿通过，GitHub Actions 门禁对此强制校验。
* **特性**：轻量极速（~50 秒完成），包含 TypeScript 严格类型检查、22 个单元测试套件、esbuild 双轨打包构建校验与 30 个无头 Playwright 端到端用例（12 个 spec 文件，含老会话置顶升权、会话实时删除与 Takeout 标题升级视觉审计），完全自包含，不依赖外网与真实 Google 账号。

### 第二层：真实调试 Chrome 全流程实跑测试 (Tier 2: Live Debug Staging)
* **执行命令**：`npm run test:live`（对应 `python3 scripts/test_live_chat_and_export.py`）。
* **适用场景**：修改了 Protobuf/JSPB 解析引擎、Google Takeout 导入逻辑、会话排序、网络请求拦截或发布新版本前。
* **环境准备**：需先通过 `./scripts/open_test_chrome.sh`（Windows 环境运行 `.\scripts\open_test_chrome.ps1` 或 `.\scripts\open_test_chrome.cmd`）启动开启 9222 调试端口的独立 Chrome 并登录测试账号。
* **运行模式与 AI 执行铁律**：
  * **模式 A（非 AI 参与 / 人工本地调试或离线复现）**：
    * 运行 `npm run test:live -- --allow-stale-dataset`（或 `python3 scripts/test_live_chat_and_export.py --allow-stale-dataset`），显式声明绕过 2 分钟新鲜度门禁，允许使用内置的高价值经典 5 轮数据集或历史静态数据集。
  * **模式 B（有 AI 参与 / 协同开发与验收）**：
    * **首选标准模式：动态 20 题多模态场景池机制 (`--pool`)**：
      1. 项目在 `scripts/test_scenario_pool.json` 维护了 20 个覆盖 10+ 领域的高价值测试场景（包含 AI 图像生成、LaTeX 公式、Markdown 表格、多语言混排、长代码等全模态特性）；
      2. 运行 `npm run test:live:pool`（或 `python3 scripts/test_live_chat_and_export.py --pool`），自动从池中出队消费 2 个最新场景（1 个含 Imagen 生图，1 个长文本深度推演），并自动归档至 `scripts/test_scenario_archive.json`；
      3. **AI 补仓铁律（用 2 补 2，常驻 20 题）**：AI 助手在协同开发、跑测试或提交 PR 前，必须运行 `npm run pool:status` 检查水位。若水位低于 20 个，必须针对当前缺口领域构思全新多模态题材补充回 20 题，杜绝同一题材（如深空探测器）反复堆积。
    * **备选模式：现场临时构思全新数据集 (`--dataset`)**：
      - 亦可由 AI 现场动态构思全新数据集并在 2 分钟（120 秒）内保存落盘并通过 `--dataset <path>` 传入运行。

  * **通用验收铁律（四大不可逾越标准）**：
    1. **必须生成真实对话（严禁滥用 `--skip-chat`）**：必须真实驱动 Gemini 并等待全部流式回复物理落地；
    2. **必须实际检验导出 Markdown 文件内容（严禁仅凭内存判断）**：测试脚本会自动将导出的 ZIP 下载到磁盘并解压，必须逐字核对会话 1 全部 5 轮与会话 2 全部 8 轮提问与回答在 Markdown 中 100% 物理存在；
    3. **必须校验老会话追加提问实时置顶、Google Takeout 离线导入与全量历史合流及网页端瞬态实时删除会话清理**：
       - **老会话实时置顶升权 (Stage 2.5)**：会话 2 生成完毕后，测试流自动回访较早创建的会话 1 并发送追加提问，检验流式生成完毕后通过 `STREAM_COMPLETE` 实时更新 `updatedAt`/`timestamp`，并在 Options 工作台中无需刷新即自动提升至列表首位（高于会话 2）；
       - **Takeout 离线合流**：测试流会自动读取预置的 `tests/fixtures/gemini_takeout_clean.zip`，检验离线导入初始提问前缀临时标题（`titleSource: takeout`），随后触发【全量拉取历史】(`btnDeepScan`) 地毯式分页同步所有云端历史，核实 Takeout 临时标题被在线 RPC 权威升级覆盖（`titleSource: rpc`）；
       - **瞬态自毁会话实时清理**：通过【瞬态自毁会话】(Live Ephemeral Chat) 真实验证网页端删除时通过 RPC 拦截与消息桥接在无需刷新的情况下实时剥离本地 Storage 与 Options DOM 列表，且绝不误伤有效会话与离线 Takeout 存档；
    4. **必须通过多模态联合导出规范断言**：当次导出会精准联合勾选 2 个现场新问答会话 + 4 种指定核心分类历史会话（AI Imagen 生图、Python 高质量代码块、Markdown 量子对比表格、深空探测长文本报告），解压后逐一核验新会话 100% 物理轮次及 4 大类别黄金语法特征与物理附件落地（索引文件、YAML Frontmatter 7 键闭合、角色交替与时间戳、0 遥测噪点、图片附件实体非空、AI Imagen 生成图模型归属断言）。

---

## 三、常用辅助命令速查

```bash
# 启动独立调试环境 Chrome (端口 9222)
./scripts/open_test_chrome.sh          # macOS / Linux
.\scripts\open_test_chrome.ps1         # Windows PowerShell
.\scripts\open_test_chrome.cmd         # Windows CMD

# 查看场景池当前水位与领域特征分布
npm run pool:status

# 运行全量实跑测试 (首选标准模式：从 20 题场景池消费 2 个最新多模态场景)
npm run test:live:pool
# 或: python3 scripts/test_live_chat_and_export.py --pool

# 运行全量实跑测试 (临时外挂模式：传入 2 分钟内动态构思的数据集)
python3 scripts/test_live_chat_and_export.py --dataset <path_to_fresh_dataset.json>

# 人工本地调试或离线复现 (绕过 2 分钟时效门禁限制，使用内置经典数据集)
npm run test:live:local
# 或: python3 scripts/test_live_chat_and_export.py --allow-stale-dataset


# 纯导出与断言验证 (跳过发帖，仅检验已有数据与 Takeout)
python3 scripts/test_live_chat_and_export.py --skip-chat

# 单独对任意导出解压目录运行规范断言器
python3 tests/helpers/export_spec_asserter.py <解压目录路径>

### 第三层：纯视觉 AI 盲测与 UI 质检体系 (Visual Inspection & Feature Parity)
* **执行命令**：
  - `npm run test:visual`：新手向导碰撞与 0 遮挡检测、排版截断、弹窗背景遮罩全屏防穿透、老会话置顶升权物理 Hit-Testing、瞬态自毁会话实时剥离布局无损审计。
  - `npm run test:visual:full`：在上述基础上闭环执行 Google Takeout 导入、全量历史扫描与标题在线权威升级、4 大核心分类黄金会话物理光标逐项勾选、物理导出 ZIP、解压资产校验与 4 大分类多模态规范断言（`ExportSpecificationAsserter`）。
  - 带多模态 AI 审查：`python3 scripts/test_visual_agent.py --full --ai-review`（可选通过 Gemini 2.0 Flash 视觉模型对全流程截屏出具质检报告）。
* **功能一致性保证**：纯视觉测试套件已与全流程实跑测试达成 100% 业务生命周期对齐，在视觉质检（0 遮挡、文本截断、背景遮罩、Hit-Testing）的基础上，物理穿透验证老会话置顶、瞬态删除清理、Takeout 合流与 4 大黄金多模态分类（Imagen 生图、Python 装饰器、量子对比表格、深空探测科学报告）物理导出规范落地。

---

## 三、常用辅助命令速查

```bash
# 启动独立调试环境 Chrome (端口 9222)
./scripts/open_test_chrome.sh          # macOS / Linux
.\scripts\open_test_chrome.ps1         # Windows PowerShell
.\scripts\open_test_chrome.cmd         # Windows CMD

# 查看场景池当前水位与领域特征分布
npm run pool:status

# 运行全量实跑测试 (首选标准模式：从 20 题场景池消费 2 个最新多模态场景)
npm run test:live:pool
# 或: python3 scripts/test_live_chat_and_export.py --pool

# 运行全量实跑测试 (临时外挂模式：传入 2 分钟内动态构思的数据集)
python3 scripts/test_live_chat_and_export.py --dataset <path_to_fresh_dataset.json>

# 人工本地调试或离线复现 (绕过 2 分钟时效门禁限制，使用内置经典数据集)
npm run test:live:local
# 或: python3 scripts/test_live_chat_and_export.py --allow-stale-dataset


# 纯导出与断言验证 (跳过发帖，仅检验已有数据与 Takeout)
python3 scripts/test_live_chat_and_export.py --skip-chat

# 单独对任意导出解压目录运行规范断言器
python3 tests/helpers/export_spec_asserter.py <解压目录路径>

# 运行纯视觉 AI 盲测与 UI 质检自动化套件 (向导 0 遮挡碰撞、老会话置顶、瞬态删除剥离与物理 Hit-Testing)
npm run test:visual

# 运行纯视觉全量全流程闭环测试 (向导 -> Takeout 导入 -> 标题权威升级 -> 4 大分类物理勾选 -> 导出 ZIP -> 规范断言 -> 视觉质检)
npm run test:visual:full
# 或带多模态审查: python3 scripts/test_visual_agent.py --full --ai-review
```

