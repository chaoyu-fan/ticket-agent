# Loopback 热路径性能基准

该基准只测本机 Chrome 内的 DOM 放行检测、证据校验和假提交点击。它不能测量、模拟或保证
官方库存、排队、风控及订单响应速度，也不能作为真实购票成功的证明。

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
库存、队列或风控。是否需要可信输入桥接只能在 Mac 无提交 rehearsal 中另行校准；该基准本身不能
解除 `liveReady=false`。
