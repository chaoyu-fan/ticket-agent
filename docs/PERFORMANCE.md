# 本机热路径性能基准

这些基准只测本机 Chrome 内的 DOM 放行检测、证据校验、隔离假点击或可信点击。它们不能测量、模拟
或保证官方库存、排队、风控及订单响应速度，也不能作为真实购票成功的证明。

## 隔离边界

- 服务只绑定随机端口的 `127.0.0.1`，CLI 不接受目标 URL 参数；
- 浏览器使用 Playwright 临时上下文，不读取 live、sandbox 或日常 Chrome profile；
- 所有非当前随机 loopback origin 的页面请求都被浏览器层拒绝；
- 页面 CSP 禁止连接、表单、图片、对象、frame、worker 和外部资源；
- “提交”是没有表单和网络行为的本地 `type=button` sink，每轮必须恰好记录一次假点击；
- stdout 只包含严格性能 JSON，不包含 URL、活动、账号、观演人、Cookie、请求或任意备注。

## 执行

需要 Node.js 22.13+ 和 Google Chrome。Mac 默认使用系统 Chrome；也可用
`TICKET_AGENT_CHROME` 指向本机 Chrome 可执行文件。

```bash
npm run --silent benchmark:loopback > loopback-performance.json
```

固定先进行 50 次不计入结果的预热，再执行 500 次热路径。JSON 中的阶段映射为：

| 目标指标 | 固定阶段 |
| --- | --- |
| DOM detect | `sale_state_detection` |
| DOM validate | `page_inspection` |
| fake action | `atomic_submit` |
| hot-path total | `run_total` |

每个阶段保留 500 个原始数字样本，并给出 nearest-rank `p50Ms`、`p95Ms`、`p99Ms`；
`run_total` 还包含每轮一次 Playwright `page.evaluate` 的本机进程到浏览器往返。
任一轮假点击数不是 1、页面发生导航、出现非 loopback 请求、报告含额外字段或超过性能门槛时，
命令以非零状态退出。这个 JSON 可以回传；不要同时回传 Chrome profile、页面 HTML 或浏览器日志。

## 真实驻留状态机的隔离基准

上面的 `benchmark:loopback` 使用 benchmark-only 简化逻辑。下面的命令改为实际调用
`runBrowserSelectionStateMachine`，其 `page.evaluate` callback 就是生产候选的
`browserSelectionTask`：

```bash
npm run --silent benchmark:state-machine > state-machine-performance.json
```

它同样固定进行 50 次预热和 500 次正式采样，但每轮会先把真实状态机启动到等待状态，再以 DOM
mutation 放出本地合成场次，由状态机完成场次、票档、数量、合成观演人选择、总价复核，并点击一次
固定的本地假 sink。严格 JSON 只包含数字样本及以下两组 nearest-rank 汇总：

- `browserLatencyMs`：浏览器 callback 启动、等待 mutation、选择、复核到假点击完成；
- `nodeEndToEndMs`：Node 调用真实 runner wrapper 到浏览器结果返回，包含 Playwright IPC。

隔离边界仍是随机 `127.0.0.1` 端口、临时 Chrome context、全量非同源请求阻断、禁止 form/network 的
CSP，以及无表单的固定 `type=button` sink。脚本不接受 URL、样本数或 profile 参数，也不会访问官方
域名、live/sandbox profile、控制器、Keychain 或 SQLite。

假 sink 由页内 `HTMLElement.click()` 触发，属于 `isTrusted=false` 的合成点击。它只能测量当前真实
状态机 callback 的本机下限，不能代表大麦真实提交控件、可信输入事件、页面跳转、订单网络响应、
库存、队列或风控。可信输入桥接已经由 `ArmedFastPath` 实现并由后文的完整合成基准覆盖；真实大麦
页面是否满足 selector、证据和 actionability contract 仍必须在 Mac 无提交 rehearsal 中校准。该
状态机基准本身不能解除 `liveReady=false`。

## 可信 ElementHandle 点击的隔离基准

最终不可逆操作不能把上面的合成点击当作可信用户输入。下面的独立命令测量 Playwright 对一个精确
`ElementHandle` 执行非 `force` actionability click 的本机往返，并要求 Chrome 产生的 click 事件满足
`event.isTrusted === true`：

```bash
npm run --silent benchmark:trusted-click > trusted-click-performance.json
```

它固定预热 50 次并采样 500 次。每轮必须恰好收到一个可信 click、零个不可信 click；严格 JSON 的
`trustedElementHandleClickMs` 汇总包含 nearest-rank `p50Ms`、`p95Ms` 和 `p99Ms`。命令还会先执行三个
fail-closed 门：精确 handle 已脱离、目标被 overlay 遮挡、目标被 disabled 时，点击必须被拒绝，原节点、
替换节点、遮罩和 disabled 节点都必须保持零 click。性能门固定为 p95 不超过 75 ms、p99 不超过
100 ms。

基准只访问随机端口 `127.0.0.1` 上的无表单 fixture，使用临时无登录 context；CLI 不接受 URL、profile
或采样数参数，浏览器层和 CSP 都禁止外部网络。`force: false`、`noWaitAfter: true`、`scroll: "none"`
保持固定，也不会回退到坐标、`HTMLElement.click()` 或重新查询替换节点。它只证明可信点击原语及
故障门；生产状态机到 submit handle 的证据交接由后文的 `ArmedFastPath` 基准另行覆盖，但两者都不能
解除 `liveReady=false`。

## 完整 ArmedFastPath 合成 Chrome 基准

以下命令把实际 resident selection 实现、同步 capability consume、最终完整 DOM 复核、精确 submit
handle 交接和一次可信 click 串成同一轮：

```bash
npm run --silent benchmark:armed-fast-path > armed-fast-path-performance.json
```

它固定预热 50 次并采样 500 次，报告以下六组 raw samples 与 nearest-rank p50/p95/p99：

- `browserSelectionLatencyMs`：resident 状态机报告的浏览器选择耗时；
- `hotPathLatencyMs`：resident selection 返回固定证据后才开始，到最终 guard 结果回读结束；它不是
  完整 T0 端到端指标；
- `consumeLatencyMs`：本进程一次性 capability 的同步消费耗时；
- `finalEvidenceLatencyMs`：最终完整证据复核、精确 handle 获取和 capture guard 安装耗时；
- `trustedClickLatencyMs`：非 force actionability click 及其结果耗时；
- `t0ToTrustedClickLatencyMs`：使用同一个浏览器单调时钟，从合成开售 DOM 放行到可信 submit click
  进入页面 handler；这是该基准中的完整 T0→click 指标。

报告 schema 是封闭的；读取报告时会重算所有 percentile，并拒绝额外字段、样本数、iteration、click
计数、fault check 或 summary 篡改。六项固定检查为：

- `exactTargetBound`：无关可信点击不能消耗 submit guard，按钮子节点的 click 仍绑定到精确 submit；
- `priceChanged`：最终 handle 获取前总价变化，保持零点击；
- `evidenceChangedAfterHandle`：handle 获取后、可信 click 前证据或价格变化，capture guard 拒绝并保持
  零 DOM click；
- `detachedHandle`、`obscuredTarget`、`disabledTarget`：都保持零 DOM click；Playwright click 结果按
  不确定处理，不能把它们误写为 Playwright 一定能够证明“未提交”。

固定合成地址虽然位于 `buy.damai.cn`，但唯一 document 由 Playwright route 本地 fulfill；任何其他请求
立即 abort，临时 context 不使用任何 Chrome profile，CLI 也拒绝所有参数和真实 URL。

服务器开发机 2026-07-31 当前实现的 500 次结果为：browser selection p50/p95/p99
`8.73/10.16/11.42 ms`，selection 返回后的 hot path `38.75/40.22/45.51 ms`，consume
`0.036/0.049/0.061 ms`，final evidence `3.81/4.34/5.30 ms`，trusted click
`34.06/35.47/39.45 ms`，浏览器 T0→trusted click `39.10/40.30/45.70 ms`。固定门为 hot path
p95/p99 不超过 `100/125 ms`、trusted click p95/p99 不超过 `75/100 ms`、T0→trusted click p95/p99
不超过 `125/150 ms`。这些数字只证明当前代码的本机合成下限与故障门，不包含真实页面导航、官方
队列、库存、网络、风控和订单响应，也不能解除 `liveReady=false/fastPathReady=false`；目标 Mac
必须连续三轮重跑。
