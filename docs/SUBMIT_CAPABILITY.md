# T-10 一次性提交能力

## 它解决什么问题

`src/security/submit-capability.ts` 把控制器的提交授权提前到 T-10 冷路径完成，并让 T0 只做本机、
同步、无 I/O 的一次消费。它减少最终点击前的 controller HTTP、SQLite 和 HMAC 开销，但不会绕过
验证码、官方队列、登录风控或支付，也不保证平台有库存。

能力使用 HMAC-SHA256 和固定的域分离字符串，最多存活 30 分钟。签名正文采用严格、规范的 JSON
结构，绑定以下内容：

- capability `version=2`、`deliveryId`、`runId`、`planId`、平台和 `canonicalEventKey`；
- 初始与最终官方 HTTPS origin、活动 ID 和活动标题；
- runner-session secret 的域分离 digest、版本化 fast-path contract digest，以及 session-keyed
  attendee-selection fingerprint；
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
`runLiveFastPathLifecycle()` 与 `ArmedFastPath` 已实现这条 ref→Keychain label→选中 DOM→attempt 闭环；
最终复核输入不包含 raw attendee ref，浏览器侧 label 会在捕获可信点击后清空。大麦仍缺真实页面
selector/evidence contract，因此实现完成不等于实盘已就绪。

能力正文的固定 schema 不接受额外字段，因此姓名、Cookie、手机号、身份证、支付资料和
Keychain 页面 label 都不能进入 token。HMAC 密钥也不得进入日志、计划、SQLite 或 GitHub。

## 正确接线顺序

HMAC token 本身不是跨进程、跨重启的全局一次性锁。当前接线按以下顺序执行：

1. Mac 在 T-10 生成 32 字节 runner-session secret，从 Keychain 解析 label，计算 session digest、
   attendee-selection fingerprint 和 reviewed contract digest；这些原值均不写 SQLite。
2. runner 先启动 resident 浏览器任务。只有页面明确 ACK `MutationObserver`、fallback、timeout 与取消
   注册已安装，才调用一次 `POST /runs/:id/submit-capability/deliver`；ACK 失败保持零交付、零提交。
3. controller 生成 delivery ID、nonce 和 envelope，然后在同一个 SQLite 事务中烧毁 delivery metadata、
   取得 `canonicalEventKey` 的 sticky purchase lock、写入 `submit_capability_grants` 并把 run 从
   `SCHEDULED` 转为 `PREWARM`。SQLite 只保存 nonce/body/session digest 与时间线，不保存 envelope、
   HMAC key、runner secret、raw attendee ref 或姓名。事务成功后首次响应才包含 envelope；响应丢失、
   controller 重启或重复请求都不能再次取得它。
4. Mac 同步调用 `prepare()` 完成 HMAC、严格 schema、session、future-issued 和 expiry 校验；随后调用
   prepared ACK。ACK 成功前 `ArmedFastPath.run()` 不会启动。capability key 在 prepare 后立即清零，
   runner-session buffer 在构造 fast path 后清零。
5. T0 时 resident task 返回固定选择证据；Node 的 `consume()` 不读取文件、Keychain、SQLite 或
   controller，不包含 `await`，并在检查 attempt 前先把状态改为 consumed。墙钟与 prepare 时锚定的
   单调时钟都必须越过 `earliestSubmitAtMs`。
6. `evaluateHandle` 最终复核同一活动、选择、观演人、连座、阻断状态、已有订单和价格，返回唯一精确
   submit 节点并安装捕获阶段复核门；随后只派发一次可信 ElementHandle click。HMAC secret/capability
   从不注入页面主世界。复核失败为零点击；click 异常为 `OUTCOME_UNKNOWN`，绝不重投。
7. 本地结果确定后才调用一次 `POST /runs/:id/submit-attempt`。上报失败只把 report status 标为 unknown，
   不会触发第二次点击或第二次上报；用户必须在可见官方页面与订单历史中核对。

delivery 成功后，通用 runner event 通道不得再改写该 run。prepared ACK 和 attempt 上报都会在
同一事务中核对 grant/run/plan/event key，并要求 run=`PREWARM`、plan=`RUNNING`、lock=`HELD`
且彼此绑定一致；过期 capability 不能首次 ACK 为 prepared。如果 delivery 已明确发生、但本地能够
证明尚未 prepared 且零点击，controller 允许用同一 `deliveryId` 直接终结为
`ZERO_CLICK_BLOCKED`，不伪造 prepared ACK；sticky lock 仍然保留，只能在用户核对官方无订单后人工对账。

CLI（或其他明确的 lifecycle 调用方）必须在首次官方导航前创建 exact page-topology guard，并把同一
实例传给 `runLiveFastPathLifecycle()`；lifecycle 会在领取前、ACK 后及点击前复查原始页仍是唯一页，
并在结束时幂等地 `dispose()` 该 guard。多标签、popup、新页或原页关闭会形成 sticky abort：领取前
发生时零交付；已完成 delivery/prepared ACK、但可信点击尚未派发时，则烧毁本地一次性能力、持久化
`ZERO_CLICK_BLOCKED` 并保持零点击。若变化发生在点击已派发之后，必须如实保留
`CLICK_DISPATCHED`/`OUTCOME_UNKNOWN`，只上报一次并要求人工核单，绝不能改写成零点击或重试。
调用方不得在导航后才创建 guard，也不得为 lifecycle 传入另一个 page 的 guard。

## 崩溃与不确定结果

`InProcessSubmitCapabilityConsumer` 的 nonce tombstone 在当前 Node module/isolate 的所有 consumer
实例之间共享；runner 必须保持单 isolate，不得通过 `worker_threads` 或重复加载模块绕开它。因此它
只保证当前进程内原子一次消费。进程崩溃会丢失内存中的 prepared/consumed handle，因此安全性必须
依赖控制器的 sticky lock 和 durable run 状态；nonce 本身不是跨重启锁：

- crash、`SIGKILL`、断电、Chrome 退出或点击结果未知后，禁止自动重签、自动重跑或 TTL 解锁；
- sticky purchase lock 只能阻止新的 run/签发，**不能单独使已经交付的 envelope 失效**；
- envelope 只能留在 runner 内存，不能进 argv、环境变量、文件、SQLite、浏览器 storage、日志或
  supervisor 重试参数；重启必须丢弃它。已存在 durable grant 时禁止重新领取 envelope，只能查询状态
  并人工 reconciliation；
- controller 已把每次 delivery 绑定 runner-session digest、claims body digest、nonce digest 与唯一
  delivery ID；SQLite grant 和 sticky lock 跨 controller 重启保留。runner 拿不到首次响应时不能恢复
  token，这是 at-most-once 语义而不是可用性故障；
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

本地 handle 的原子消费只覆盖当前进程；跨进程/跨重启唯一性由 controller 的 durable delivery grant、
runner-session 绑定和 sticky lock 共同提供。两层都必须存在，不能把任一层单独当作完整数据库锁。
