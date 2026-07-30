# T-10 一次性提交能力

## 它解决什么问题

`src/security/submit-capability.ts` 把控制器的提交授权提前到 T-10 冷路径完成，并让 T0 只做本机、
同步、无 I/O 的一次消费。它减少最终点击前的 controller HTTP、SQLite 和 HMAC 开销，但不会绕过
验证码、官方队列、登录风控或支付，也不保证平台有库存。

能力使用 HMAC-SHA256 和固定的域分离字符串，最多存活 30 分钟。签名正文采用严格、规范的 JSON
结构，绑定以下内容：

- `runId`、`planId`、平台和 `canonicalEventKey`；
- 官方 HTTPS origin、活动 ID 和活动标题；
- 数量、连座要求、完整的场次/票档优先级；
- 观演人 opaque refs 的数量和 `sha256:` 指纹，绝不包含 raw ref 或页面姓名；
- 最高总价，以及每个票档可选的最高单价；
- `issuedAtMs`、签名绑定的 `earliestSubmitAtMs`、`expiresAtMs` 和 32 字节随机 nonce。定时开售时
  `earliestSubmitAtMs` 必须来自已审核计划的 `saleAt`；已在售活动才允许它等于签发时间。

T0 attempt 必须再次提供当前页面对应的活动绑定、观演人计数/指纹、实际选中的场次及其优先级、
票档及其优先级、票档单价和唯一订单总价。当前策略还要求
`selectedTierUnitPriceFen * quantity <= observedTotalFen <= maxTotalFen`；只允许明确可解释的费用使
总价高于票面行总额，暂不允许未建模的折扣。任一值不匹配、总价超限或单价超限都会烧毁能力并停止，
不会再尝试第二次点击。

观演人指纹不是页面证明本身。状态机必须先用 T-10 内存中的 ref→label 映射逐一确认页面上唯一的
选中观演人，再从**实际确认的 refs**调用同样的 audit helper 计算 attempt 指纹；不能把 claims 中的
指纹原样复制回 attempt。`requireAdjacent` 也必须来自页面的连座证据，而不是只回显计划布尔值。
这条 ref→label→DOM→attempt 闭环尚未接入当前 runner，是 live submit 的硬门；在接线完成并有真实
页面演练证据前，不能把本模块当作已具备观演人自动提交能力。

能力正文的固定 schema 不接受额外字段，因此姓名、Cookie、手机号、身份证、支付资料和
Keychain 页面 label 都不能进入 token。HMAC 密钥也不得进入日志、计划、SQLite 或 GitHub。

## 正确接线顺序

HMAC token 本身不是跨进程、跨重启的全局一次性锁。控制器接线必须按以下顺序进行：

1. 在 controller 的同一个 SQLite 事务中，检查 run/plan 状态，取得该
   `canonicalEventKey` 的唯一 sticky purchase lock，并把 run 持久化标记为 capability
   prepared。唯一约束必须阻止同活动的第二个非终态 run 或第二次签发。
2. 事务成功提交后，才允许根据同一份不可变 binding 签发能力。可以在事务前生成随机 nonce，
   只把 nonce 的 SHA-256 摘要和到期时间写入 prepared 记录；不得持久化完整 envelope 或 HMAC
   密钥。如果事务回滚，不得签发或返回 token。
3. Mac runner 在 T-10 收到 envelope 后立即调用 `prepare()` 完成 HMAC、schema、future-issued 和
   expiry 校验。只在当前进程内保存返回的 frozen handle；不得写文件、SQLite、日志或浏览器
   storage。
4. 浏览器内状态机可以在 T0 前完成可逆预选并返回固定证据。只有本机墙钟和 `prepare()` 时锚定的
   单调时钟都越过签名 `earliestSubmitAtMs` 后，Node 才可用这些证据调用同步 `consume()`。该函数
   不读取文件、Keychain、SQLite 或控制器，不包含 `await`，并在检查 attempt 前先把进程内状态改为
   consumed。
5. consume 成功后，第二个最小浏览器任务必须重新复核同一活动、选择、观演人和价格证据，绑定精确
   submit 节点，再用一次可信浏览器输入点击。HMAC secret/capability 不得注入页面主世界；若复核、
   handle actionability 或点击结果不确定，保持 sticky lock 并人工接管，绝不重投。
6. 点击之后再异步写审计和读取可见订单结果。点击成功不等于购票成功；仍需看到官方订单或待支付
   证据，支付由用户完成。

第 1、2 步尚未接入 `controller/store.ts` 和 HTTP API；当前模块只提供安全数据模型、签名和本地
消费原语。没有 sticky lock 和 durable prepared 记录时，不得把它接到 live submit。

## 崩溃与不确定结果

`InProcessSubmitCapabilityConsumer` 的 nonce tombstone 在当前 Node module/isolate 的所有 consumer
实例之间共享；runner 必须保持单 isolate，不得通过 `worker_threads` 或重复加载模块绕开它。因此它
只保证当前进程内原子一次消费。进程崩溃会丢失内存中的 prepared/consumed handle，因此安全性必须
依赖控制器的 sticky lock 和 durable run 状态；nonce 本身不是跨重启锁：

- crash、`SIGKILL`、断电、Chrome 退出或点击结果未知后，禁止自动重签、自动重跑或 TTL 解锁；
- sticky purchase lock 只能阻止新的 run/签发，**不能单独使已经交付的 envelope 失效**；
- envelope 只能留在 runner 内存，不能进 argv、环境变量、文件、SQLite、浏览器 storage、日志或
  supervisor 重试参数；重启必须丢弃它，并向 controller 重新握手；
- controller 必须为每次 runner session 绑定一次性 delivery nonce（或采用等价的短生命周期
  runner-session ephemeral secret），拒绝已交付 nonce 的再次投递。该 durable delivery/会话接线
  尚未实现，是 live submit 的硬门；
- sticky purchase lock 必须继续保持，run 进入需要人工处理的不确定状态；
- 用户先在大麦官方订单历史中核对是否生成订单；
- 只有确认无订单、无订单号证据并完成控制器人工 reconciliation 后，才可按现有安全流程处理锁；
- 已确认购票的锁永久保持，绝不因 token 到期而释放。

这意味着能力过期只会让本机点击授权失效，不会改变数据库购买锁。两者职责不能合并。

## 时间与 replay 语义

- `issuedAtMs` 晚于当前时间时立即拒绝，不接受隐式时钟宽限；Mac 和控制器必须预先完成系统校时。
- `prepare()` 允许在 `earliestSubmitAtMs` 前完成 HMAC 和 schema 校验；`consume()` 同时要求当前墙钟
  与从 prepare 时刻累计的单调时间都跨过该门槛。墙钟突然向前跳不能提前放行，向后回拨则
  fail-closed；过早 consume 会烧毁该次能力。
- `expiresAtMs <= now` 即为过期；消费时会再次检查，不能依赖 T-10 的一次验证。
- consumer 的 `prepare()`/`consume()` 不接受逐次时间参数；生产构造使用默认 `Date.now`。构造时 clock
  注入只用于确定性单测，live 接线不得传固定或可回拨的自定义时间源。
- 同一 nonce 重复 `prepare()`、同一 handle 重复 `consume()`、并发 consume、伪造 handle 都会拒绝。
- 第一次 consume 即使因为活动、观演人、票档或价格不匹配而失败，也已经烧毁该进程内能力。
- consumer 检测到调用方时间回拨时 fail-closed，避免过期 token 被重新解释为有效。

这些语义只覆盖当前进程；跨进程/跨重启唯一性仍需前述 controller 的 durable delivery 记录、
runner-session 接线和 sticky lock 共同提供，不能把本模块误当作数据库锁。
