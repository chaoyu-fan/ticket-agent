# 极速购票热路径

## 目标和边界

“极速”指把 Mac 本地可控的检测、选择、校验与一次点击开销压到尽可能低，并用单调时钟和
p50/p95/p99 实测。官方库存、排队顺序、平台服务器响应、网络拥塞和风控不在客户端控制范围内，
因此任何本地延迟指标都不能解释为购票成功保证。

只允许单账号、单专用 Chrome profile、单页面和一次提交能力。不使用高频刷新、并发页面、
私有接口、验证码绕过、代理池、指纹伪装或多账号并发。

## 票档策略

极速模式采用 `PREFERRED_ORDER`：用户在开售前给出可接受票档的优先级，并设置明确的
`maxTotalFen`。开售后选择第一个可见、可用且不超预算的预批准票档。

`CHEAPEST_FIRST` 仍适合低热度活动，但它需要读取和比较全部候选票档。热门活动不应同时要求
“绝对最低价”和“最先可买”；动态比价会增加关键路径工作量，也可能错过先出现的合规库存。

## 冷路径：最晚在 T-10 分钟完成

以下工作不得留到开售瞬间：

1. 启动可见 Chrome，确认专用 profile、登录状态、活动 URL、活动 ID 和标题。
2. 从 macOS Keychain 把 opaque `attendeeRefs` 解析为仅存在于进程内存的页面匹配值。
3. 固化场次顺序、票档顺序、数量、连座要求和最高总价。
4. 编译并验证版本化 selector/evidence contract，预热页面、DNS/TLS 连接和 JavaScript 运行环境。
5. 在页面内安装 resident `MutationObserver`、fallback、timeout 与取消注册，并等待明确 armed ACK。
6. armed ACK 后只向 controller 领取一次 capability；controller 在同一 SQLite 事务中烧毁 delivery、
   获取 sticky purchase lock 并把 run 转入 `PREWARM`。Mac 随即完成 HMAC `prepare()` 和 prepared ACK。
7. 清零 capability key 与 runner-session buffer，并检查系统自动校时、网络稳定性、电源和休眠设置。

## 热路径：T0 后

目标结构如下：

```text
页面 DOM 变化
    -> MutationObserver 唤醒
    -> 浏览器内驻留状态机完成场次/票档/数量/观演人选择
    -> 浏览器任务复核活动、选择证据、唯一总价和预算并返回固定证据
    -> Node 本机同步消费一次性提交能力
    -> 第二个最小复核任务确认同一证据和精确 submit 节点，再派发一次可信输入
    -> 异步回传审计，等待可见订单/待支付证据
```

热路径禁止读取文件、Keychain、SQLite 或远端控制器；禁止整页 `body.innerText` 扫描；禁止在每个
选择阶段等待同步审计。正常提交至少需要“驻留任务返回”和“可信输入”两个必要的本机边界；HMAC
密钥和 capability 绝不能为了省这一次边界而注入页面主世界。支付、验证码、短信、
人脸验证及异常登录仍由用户处理。

## 浏览器内驻留状态机基础模块

`src/runner/browser-selection-state-machine.ts` 已提供 production lifecycle 会调用的驻留基础模块；大麦
实盘仍因缺少已审核 contract 而保持关闭。
正常完成路径只跨越一次 `page.evaluate`：同一个浏览器任务安装 `MutationObserver`，等待公开 DOM，
依次完成场次、`PREFERRED_ORDER` 票档、数量和观演人选择，再在同一任务中重新验证活动、所选票档
可见价格、数量、观演人数、连座证据、唯一总价和预算。任务不读取 `body.innerText`，不刷新、不导航、
不开并发页面，也没有任何真实提交订单选择器。observer 是主触发；仅在页面属性变化未形成可观察
mutation 时使用 16 ms 的一帧级本地 DOM fallback，不产生网络请求。可逆 click target 还会经过不可
被 contract 覆盖的原生 submit/form/navigation 拒绝规则；平台特有的不可逆控件仍必须列入 contract。

生产候选可以显式开启 `waitInOfficialQueue`：官方队列可见时，同一个浏览器任务只保持 observer 驻留，
不选择、不刷新，也不重新跨越 Node 边界；队列消失后才继续。CAPTCHA、登录失效和售罄即使与队列
同时出现也仍立即阻断。活动标题或 ID 尚未渲染时只等待且保持零动作，出现多份证据或任一身份不匹配
则立即阻断；任务仍受调用方 timeout、取消信号和页面导航销毁约束。驻留 timeout 的硬上限为 30 分钟，
用于覆盖 T-10 预热到 capability 到期的有界窗口，而不是无限等待。`startBrowserSelectionStateMachine()`
现在会额外返回 `armed` 与 `result`：只有浏览器确认 observer 已安装，production lifecycle 才能领取
一次性 capability；ACK 失败保持零提交。

该模块要求 contract 明确包含 CAPTCHA、登录失效、售罄和官方队列四类阻断选择器。正常模式仅接受
与 `platform` 对应的官方 HTTPS host；测试假点击仅允许 HTTPS `.test`，或带明确临时端口的
`http://127.0.0.1` / `http://localhost`，且只能点击带固定
`data-ticket-agent-test-sink="browser-selection-v1"` 标记的无表单 `type=button`。点击过的选项若被页面
替换、页面发生跳转或假点击结果不能被同步证明，任务立即失败关闭且绝不重试。

它仍不是大麦实盘 selector 实现。Mac 必须先用仓库外私有 plan/contract 做
`--contract-rehearsal` 无提交校准（具体命令见 [docs/CONTRACT_REHEARSAL.md](CONTRACT_REHEARSAL.md)），
逐项核对并留存以下接口证据后，才能考虑由 Damai adapter 调用：

1. 实际购票页官方 origin、唯一活动标题和活动 ID 来源；
2. 场次、票档、数量、观演人的 option、可见 label、selected marker 和可逆 click target；
3. 票档可见价格节点及其可交叉验证的整数分属性；
4. 场次、票档、数量 summary、连座标记、唯一总价及整数分属性；
5. CAPTCHA、登录、售罄、官方队列以及所有不可逆操作控件的选择器。

contract rehearsal 的零提交报告只能证明 selection、唯一 submit-readiness 及 post-submit selector
的 schema/CSS 语法；`postSubmitEvidence=NOT_OBSERVED`，不能证明真实订单号/待支付证据。当前状态机还
要求这些选择与总价在同一 canonical page/document；详情页到确认页的独立阶段必须先设计 versioned
staged contract，否则 fail-closed。

在这些选择器通过真实页面只读校准和无提交演练前，`DamaiAdapter.liveReady` 与
`DamaiAdapter.fastPathReady` 都继续为 `false`，adapter-bound contract 与 digest 也必须为空；
Mac 仓库外私有 contract 的存在不等于 adapter 已绑定或 live 已就绪。

最终不可逆点击不会复用状态机中的 `HTMLElement.click()`：该事件为 `isTrusted=false`。
`ArmedFastPath` 现在接收已驻留任务，Node 同步先烧毁 capability，再用一个最小 `evaluateHandle` 任务
复核活动、场次、票档、数量、观演人、连座、总价、阻断态和已有订单证据；它返回唯一精确 submit
ElementHandle，并安装捕获阶段的一次复核门。随后只调用一次 `force:false`、`scroll:"none"` 的可信
actionability click。点击异常一律记为 `OUTCOME_UNKNOWN`，不重试。handle 获取前价格变化会在最终
证据复核处阻断；handle 获取后、可信 click 前证据变化会被 capture guard 拒绝并明确记为
`ZERO_CLICK_BLOCKED`。handle 脱离、被遮挡或 disabled 也都验证为零 DOM click，但 Playwright click
结果按不确定处理，不能据此把结果误报成“确定未提交”。该链路已接入 `--live` 专用 lifecycle，但
没有大麦真实 contract 时仍不可启动；不能用约 1-3 ms 的坐标/CDP 点击换取误点风险。

## 当前基线

隔离 loopback 基准固定进行 50 次预热和 500 次正式运行，测量 DOM 放行、固定证据校验、假点击及
包含一次 Playwright 往返的总耗时。它使用临时无登录 Chrome context，不能访问官方站点，也没有
真实提交能力：

```bash
npm run --silent benchmark:loopback > loopback-performance.json
```

服务器开发机的首轮 500 次结果为：DOM 检测 p99 约 0.1 ms、固定证据校验 p99 约 0.2 ms、
假点击 p99 约 0.1 ms、包含一次 Playwright 往返的总耗时 p50/p95/p99 约
1.32/1.94/2.66 ms。最终验收必须在实际执行购票的 Mac 上重跑；不同 CPU、Chrome 版本和系统负载
会产生不同结果。

该 loopback 基准使用 benchmark-only DOM 和假点击逻辑，并未调用上述驻留状态机；它只能作为
Playwright 往返与浏览器内操作的隔离基线，不能证明完整状态机或真实大麦页面达到相同延迟。

真实驻留状态机还必须单独运行：

```bash
npm run --silent benchmark:state-machine > state-machine-performance.json
```

该基准同样固定 50 次预热和 500 次正式采样，但会实际调用
`runBrowserSelectionStateMachine`/`browserSelectionTask`，等待 DOM mutation 后完成场次、票档、数量、
合成观演人选择、总价复核及一次固定本地假 sink 点击。服务器开发机集成后一次 500 次结果为：
浏览器内完整关键路径 p50/p95/p99 约 1.60/1.90/2.20 ms；包含 Node、Playwright IPC 和浏览器返回的
端到端结果约 8.37/9.48/10.12 ms。该点击为 `isTrusted=false`，这些数字仍只是本地临时 Chrome 的隔离下限，
不能代表大麦真实提交控件、导航、库存、排队、网络或风控；Mac 必须重测。

可信输入的独立隔离基准为：

```bash
npm run --silent benchmark:trusted-click > trusted-click-performance.json
```

它对精确 `ElementHandle` 使用 `force: false` 的 actionability click，固定验证 500 轮均为一次
`isTrusted=true` click，并验证 handle 脱离、目标被遮挡和 disabled 时全部零 DOM click。服务器开发机
首轮 p50/p95/p99 约为 31.70/33.27/41.09 ms，通过 p95 <= 75 ms、p99 <= 100 ms 的门。这个独立基准
只隔离可信点击原语；生产候选的证据交接已经由 `ArmedFastPath` 实现并由下一个基准覆盖，不能把两个
独立基准数字相加后宣称真实端到端性能。真实页面 actionability、渲染、导航、官方网络和队列仍未
包含，必须在实际执行的 Mac 上重跑并分阶段测量。

完整已武装链路的合成 Chrome 基准为：

```bash
npm run --silent benchmark:armed-fast-path > armed-fast-path-performance.json
```

它固定使用合成 `https://buy.damai.cn/__ticket_agent_armed_fast_path_benchmark_v1__` 地址，但所有请求都由
Playwright 本地 route fulfill；任何其他网络请求立即 abort，且使用临时无 profile context。基准执行
50 次预热、500 次采样，覆盖 resident 选择结果、同步 consume、最终完整证据复核与一次
`isTrusted=true` ElementHandle click。报告包含六组指标：

- `browserSelectionLatencyMs`：resident 状态机报告的浏览器选择耗时；
- `hotPathLatencyMs`：resident selection 已返回固定证据后才开始，到最终 guard 结果回读结束；它不是
  完整 T0 端到端指标；
- `consumeLatencyMs`：进程内一次性 capability 同步消费；
- `finalEvidenceLatencyMs`：最终证据复核、精确 handle 获取和 capture guard 安装；
- `trustedClickLatencyMs`：非 force actionability click 及其结果；
- `t0ToTrustedClickLatencyMs`：使用同一个浏览器单调时钟，从合成开售 DOM 放行到可信 submit click
  进入页面 handler；这是该合成基准中的完整 T0→click 指标。

六项固定检查为：`exactTargetBound`（无关可信点击不能消耗 guard，按钮子节点的 click 仍精确绑定
submit）、`priceChanged`（最终 handle 获取前价格变化）、`evidenceChangedAfterHandle`（handle 获取后、
可信 click 前证据变化）、`detachedHandle`、`obscuredTarget` 和 `disabledTarget`。`priceChanged` 与
`evidenceChangedAfterHandle` 都明确返回 `ZERO_CLICK_BLOCKED`；后三类保持零 DOM click，但
Playwright click 结果按不确定处理。报告使用封闭 schema，校验器会从 raw samples 重算
p50/p95/p99 并拒绝字段、样本数、fault 结果和
percentile 篡改；CLI 拒绝所有参数，因此不能传入真实活动 URL。

2026-07-31 当前实现于服务器开发机的 500 次结果为：browser selection p50/p95/p99
`8.73/10.16/11.42 ms`，selection 返回后的 hot path `38.75/40.22/45.51 ms`，同步 consume
`0.036/0.049/0.061 ms`，最终证据复核 `3.81/4.34/5.30 ms`，可信点击
`34.06/35.47/39.45 ms`，浏览器 T0→可信点击 `39.10/40.30/45.70 ms`。门槛为 hot path p95/p99
不超过 `100/125 ms`、可信点击 p95/p99 不超过 `75/100 ms`、T0→可信点击 p95/p99 不超过
`125/150 ms`。这些数字仍不包含真实大麦 DOM、跨文档导航、官方网络、队列、库存或风控；最终结论
只能来自目标 Mac 连续三轮实测。

## 上线前性能门

1. Mac 的 loopback 简化基准、真实驻留状态机基准、可信 ElementHandle 点击基准和完整 armed
   fast-path 基准均连续三轮各 500 次通过，并保留严格脱敏 JSON。
2. 官方页面只读校准能够稳定识别开售、官方队列、登录异常、验证码和售罄状态。
3. 无提交能力的确认页演练能够正确选择并复核活动、场次、票档、数量、观演人和总价；随后用同一
   脱敏 contract 验证唯一 submit 控件、遮罩、动画、节点替换与 actionability，但不在热门活动上做试单。
4. 真实页面状态机逐阶段记录 p50/p95/p99，确认没有文件、Keychain、SQLite、控制器 HTTP 或整页文本
   扫描进入 T0 热路径。
5. 价格变化、页面改版、重定向、重复运行和未知点击结果都保持零重试或人工接管。

在第 2、3 项完成且用户明确最高总价、场次顺序和票档顺序前，大麦 `liveReady` 与 `fastPathReady`
必须继续为 `false`。
