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
4. 编译并验证选择器，预热页面、DNS/TLS 连接和 JavaScript 运行环境。
5. 取得该活动唯一购买锁，并准备有期限、单次消费的本地提交能力。
6. 检查系统自动校时、网络稳定性、电源和休眠设置。

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

`src/runner/browser-selection-state-machine.ts` 已提供一个独立、尚未接入实盘适配器的基础模块。
正常完成路径只跨越一次 `page.evaluate`：同一个浏览器任务安装 `MutationObserver`，等待公开 DOM，
依次完成场次、`PREFERRED_ORDER` 票档、数量和观演人选择，再在同一任务中重新验证活动、所选票档
可见价格、数量、观演人数、连座证据、唯一总价和预算。任务不读取 `body.innerText`，不刷新、不导航、
不开并发页面，也没有任何真实提交订单选择器。observer 是主触发；仅在页面属性变化未形成可观察
mutation 时使用 16 ms 的一帧级本地 DOM fallback，不产生网络请求。可逆 click target 还会经过不可
被 contract 覆盖的原生 submit/form/navigation 拒绝规则；平台特有的不可逆控件仍必须列入 contract。

该模块要求 contract 明确包含 CAPTCHA、登录失效、售罄和官方队列四类阻断选择器。正常模式仅接受
与 `platform` 对应的官方 HTTPS host；测试假点击仅允许 HTTPS `.test`，或带明确临时端口的
`http://127.0.0.1` / `http://localhost`，且只能点击带固定
`data-ticket-agent-test-sink="browser-selection-v1"` 标记的无表单 `type=button`。点击过的选项若被页面
替换、页面发生跳转或假点击结果不能被同步证明，任务立即失败关闭且绝不重试。

它仍不是大麦实盘 selector 实现。Mac 无提交演练必须逐项校准并留存以下接口证据后，才能考虑由
Damai adapter 调用：

1. 实际购票页官方 origin、唯一活动标题和活动 ID 来源；
2. 场次、票档、数量、观演人的 option、可见 label、selected marker 和可逆 click target；
3. 票档可见价格节点及其可交叉验证的整数分属性；
4. 场次、票档、数量 summary、连座标记、唯一总价及整数分属性；
5. CAPTCHA、登录、售罄、官方队列以及所有不可逆操作控件的选择器。

在这些选择器通过真实页面只读校准和无提交演练前，状态机保持独立，`DamaiAdapter.liveReady` 继续为
`false`。

最终不可逆点击不能直接复用状态机中的 `HTMLElement.click()`：该事件为 `isTrusted=false`。生产候选
应让驻留任务返回固定证据，由 Node 消费 capability 后，通过精确 ElementHandle 的非 force
actionability click 派发可信输入，并在第二个最小任务中重新核对完整绑定。这个桥接尚未实现；Mac
演练还必须测量 handle 脱离、遮罩、动画和价格变化，不能用约 1-3 ms 的坐标/CDP 点击换取误点风险。

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
浏览器内完整关键路径 p50/p95/p99 约 1.80/2.40/2.80 ms；包含 Node、Playwright IPC 和浏览器返回的
端到端结果约 8.54/10.07/11.80 ms。该点击为 `isTrusted=false`，这些数字仍只是本地临时 Chrome 的隔离下限，
不能代表大麦真实提交控件、导航、库存、排队、网络或风控；Mac 必须重测。

## 上线前性能门

1. Mac 的 loopback 简化基准和真实驻留状态机基准均连续三轮各 500 次通过，并保留严格脱敏 JSON。
2. 官方页面只读校准能够稳定识别开售、官方队列、登录异常、验证码和售罄状态。
3. 无提交能力的确认页演练能够正确选择并复核活动、场次、票档、数量、观演人和总价，并确认页面
   是否接受合成点击；最终提交必须另行实现和演练可信 ElementHandle 输入，不能由假 sink 基准推断。
4. 真实页面状态机逐阶段记录 p50/p95/p99，确认没有文件、Keychain、SQLite、控制器 HTTP 或整页文本
   扫描进入 T0 热路径。
5. 价格变化、页面改版、重定向、重复运行和未知点击结果都保持零重试或人工接管。

在第 2、3 项完成且用户明确最高总价前，大麦 `liveReady` 必须继续为 `false`。
