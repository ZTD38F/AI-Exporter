# Gemini L1 响应分层

采集与接口处理分开，解析器内部按请求上下文和资源证据进一步收拢。
MAIN/ISOLATED 各自验证收到的证据；入库及后续工作流保持独立职责。

| 职责 | 唯一入口 | 负责内容 |
| --- | --- | --- |
| 网络采集 | `sniffer/gemini/hookCredentials.ts` | 包装 fetch/XHR，捕获发送时的账号、slot、时间和页面路径，限量读取响应，报告成功、截断、取消或异常 |
| 接口分发 | `sniffer/gemini/responses/router.ts` | 按协议、主机及 URL 路径选择接口处理器；不解析正文，不根据正文猜测接口 |
| batchexecute 处理 | `sniffer/gemini/responses/batchexecute.ts` | 绑定请求与响应，检查 DELETE 回执，转发 LIST/DETAIL 的原始响应和请求上下文 |
| StreamGenerate 处理 | `sniffer/gemini/responses/streamGenerate.ts` | 识别流式帧、判断完成、抑制重复完成通知，并维护页面侧流状态 |
| batchexecute RPC 解析分发 | `parsers/gemini/rpc/parseResponse.ts` | 主动请求和被动捕获共享 envelope，按 RPC ID 交给现有 LIST/DETAIL parser |

fetch 和 XHR 共用同一个 URL 路由和相同的处理器。处理器各自声明响应读取上限，
采集层不包含 RPC ID、删除回执或流式帧的语义判断。

batchexecute 是多个 RPC 的传输容器，所以还保留 RPC ID 级分发。
跨世界的 DELETE 校验仍在接收侧执行；这不是另一个网络采集入口。
未知接口直接忽略，不将其正文试喂给已知 parser。

账号发现与请求凭据采集保留原来的独立生命周期。此次没有接管 ChatGPT、Claude
或 Takeout 的入口，也没有新增统一所有平台的抽象框架。

## Gemini 内部解析契约

- `rpc/request.ts` 一次解码 `f.req`，由各 RPC 的参数 decoder 产出 LIST、DETAIL、DELETE 的具体请求事实；同类 RPC 重复时不建立唯一身份。已删除分别读取请求 batch 的两个 reader。
- `batchexecute` 处理器复用同一个请求结果；删除回执进入 ISOLATED 时重新校验原始请求和响应，不能信任页面传来的确认标志。
- `sourceAttachments.createDocumentReader` 由每份 DETAIL 响应拥有，第一次文档查询才扫描响应树。所有 Turn 共用候选证据，按节点复用解析结果；资源组装只消费段落、链接和匹配依据。
- 文档保留源顺序、短 ID 子串匹配的启发式标记、标题唯一性和无归属拒绝规则，不把全文提及误认为身份。
- storage/MAIN 凭据使用同一字段 decoder；未验证字段不能通过断言进入 bootstrap。接口路由的 runtime 消息也先按 unknown 校验。
- Gemini parser、client、sniffer 和 Takeout IO 目录全部受禁止断言/非空断言的 Compiler AST 门禁和 type-aware unsafe-flow lint 约束。

Takeout ZIP 的加载、库存校验和 entry 方法适配统一归 `imports/takeout/readArchive.ts`；导入器只消费解析结果并报告进度，不再二次加载或校验归档。

外部 wire、DOM、storage 和消息边界仍接收 `unknown`；专用媒体/结构化内容 decoder 也需要验证尚未识别的原始槽位。身份缓存的 object key 与串行操作中保持输入输出关系的泛型不代表业务载荷类型逃逸。它们不要求已解析的内容适配器或 L2 再猜测源响应形状。

## ISOLATED 接入与处理边界

- `sniffer/gemini/messageBridge.ts` 只接收同窗口同源消息，交给唯一的 `parsers/gemini/capturedSource.ts`，并维护已收到网络响应的提交等待屏障。
- `capturedSource.ts` 在任何账号分配前验证消息、源 URL、捕获大小、请求关联和删除回执。它产出 `GeminiCapturedSource` 判别联合：network、deleted、stream-start、stream-complete。network 只携带已解析 LIST/DETAIL 与对应请求上下文，不把 RPC 正文传给处理层。
- `sniffer/gemini/captureReceiver.ts` 消费具体结果，负责账号归属后的来源事实提交、短生命周期分页拼接和通知。DOM 元数据通过专用 DOM parser 读取，既有 ZIP 导入通过专用 archive reader 读取；它们不新增独立平台 Provider。
- 每次初始化拥有独立的分页证据缓存；上一接收器的页不能在新生命周期建立完整性。消息字段在进入边界时取快照，异步等待期间不再从原消息重读会话身份。
- 删除继续在 MAIN 与 ISOLATED 分别验证原始请求/回执；接收器只收到已确认的会话 ID，等待此前捕获完成后才删除。STREAM_COMPLETE 也等待此前捕获提交；STREAM_START 不等待。
- Compiler AST 门禁约束 `parseGeminiResponse` 仅由主动 client 与被动 capturedSource 入口使用，LIST/DETAIL 底层 parser 由 parseResponse 分发。接收器禁止 unknown/any/object、泛型和对业务载荷的 typeof 探测；保留 document/location 的原生能力判断。别名、命名空间调用和再导出均纳入门禁回归。
