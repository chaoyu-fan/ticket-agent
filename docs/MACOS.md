# macOS 落地流程

## 1. 安装与预检

安装 Node.js 22.13+ 和 Google Chrome，将项目复制到 Mac 后执行：

```bash
npm ci
bash scripts/setup-macos.sh
npm run check
npm test
```

在执行真实页面演练前，连续运行三轮隔离基准并分别保存脱敏 JSON：

```bash
npm run --silent benchmark:loopback > loopback-performance-1.json
npm run --silent benchmark:loopback > loopback-performance-2.json
npm run --silent benchmark:loopback > loopback-performance-3.json
npm run --silent benchmark:state-machine > state-machine-performance-1.json
npm run --silent benchmark:state-machine > state-machine-performance-2.json
npm run --silent benchmark:state-machine > state-machine-performance-3.json
npm run --silent benchmark:trusted-click > trusted-click-performance-1.json
npm run --silent benchmark:trusted-click > trusted-click-performance-2.json
npm run --silent benchmark:trusted-click > trusted-click-performance-3.json
npm run --silent benchmark:armed-fast-path > armed-fast-path-performance-1.json
npm run --silent benchmark:armed-fast-path > armed-fast-path-performance-2.json
npm run --silent benchmark:armed-fast-path > armed-fast-path-performance-3.json
```

第一组三轮是 benchmark-only 的 DOM/假点击下限；第二组实际调用驻留状态机，覆盖 DOM mutation、
场次、票档、数量、合成观演人选择、总价复核和固定假 sink；第三组测量精确 ElementHandle 的非 force
可信点击，并验证脱离、遮挡和 disabled 时零 DOM click；第四组覆盖完整 resident selection →
synchronous consume → final evidence → trusted click 链路。armed 报告必须包含六组指标，其中
`hotPathLatencyMs` 从 resident selection 返回固定证据后才开始；使用同一浏览器单调时钟的
`t0ToTrustedClickLatencyMs` 才是合成基准中的完整 T0→click 指标。它同时验证精确目标绑定、handle
获取前价格变化、handle 获取后证据变化、handle 脱离、遮挡和 disabled 六项检查。后三项虽然保持零
DOM click，但 Playwright click 结果按不确定处理。

armed 基准的固定门为 hot path p95/p99 `100/125 ms`、trusted click p95/p99 `75/100 ms`、
T0→trusted click p95/p99 `125/150 ms`。四种基准都只使用临时无登录 Chrome，armed 基准的固定合成
大麦 URL 由本地 route fulfill，其他请求全部 abort。前两种的假点击为 `isTrusted=false`；后两种要求
`isTrusted=true`，但仍没有大麦真实选择器、网络、队列、库存、风控或订单响应，不能据此宣称真实
购票达到相同延迟或解除 `liveReady=false/fastPathReady=false`。

不要把日常 Chrome 的目录、其父目录或 `Default` profile 配给执行器；live 与 sandbox profile 也不能相同或互为父子目录。首次使用 live 专用 profile 时，账号登录、实名观演人维护和安全验证都由用户在可见浏览器中完成。

### 启动恢复页策略

- `dry-run` / `mock`：在无提交 sandbox 中，初始 0/1 页时先创建 runner-owned fresh page，再关闭唯一
  restored page；初始多页不自动清理并 fail-closed。
- `rehearsal` / `live`：只替换唯一严格的 `about:blank`。唯一非空或多个 restored page 会报
  `RESTORED_PAGE_REVIEW_REQUIRED`，保持可见供用户核对，直到用户关闭整个 TicketAgent 浏览器或按 `Ctrl-C`。
- `login-only`：保留全部 restored page，只另开一个人工登录页，不在其他页面执行自动操作。

`page.close()` 只关闭一个页面实例，但会改变 Chrome 的恢复标签列表。实现不会删除 profile 目录，也不会
主动清除 Cookie、localStorage、Keychain 或登录数据；官方网页正常访问仍可能更新自己的 Cookie。遇到
`RESTORED_PAGE_REVIEW_REQUIRED` 时，agent 不得自动关闭未知订单/支付页。用户可先用 `login-only` 人工
核对；确认没有未知订单后，由用户自行关闭相关标签或整个 TicketAgent 浏览器。禁止通过删除 profile、复制
登录态或擅自移除 lock 来消除错误。

## 2. 只读配置检查

执行默认计划的只读检查：

```bash
npm run build
npm run start:runner -- --dry-run --plan examples/default-damai-plan.json
```

预期结果是 `REVIEW_REQUIRED`，且没有浏览器、网络请求或点击。

已经确认可访问的低热度校准活动使用独立计划，不覆盖通用默认计划。profile 生命周期修复后必须在同一个
默认 sandbox 中顺序运行两次；第一轮未通过时停止：

```bash
npm run build

env -u TICKET_AGENT_SANDBOX_PROFILE \
  npm run start:runner -- --dry-run \
  --plan examples/damai-iwwf-readonly-plan.json

env -u TICKET_AGENT_SANDBOX_PROFILE \
  npm run start:runner -- --dry-run \
  --plan examples/damai-iwwf-readonly-plan.json
```

该计划绑定大麦活动 ID `1067493715985`，固定为一张、最低价优先且
`autoSubmitOrder=false`。一般 selector 校准可能以 `PAGE_CHANGED` 或“缺少唯一订单总价”停止；详情页尚未
进入选票/确认页时不代表链接失效。但本轮默认 profile 修复验收要求两轮均为 `REVIEW_REQUIRED`、当前已知
观测总价 `5800` 分并确认零选票/零提交点击。两轮之间不得删除、迁移、替换或清理默认 sandbox；临时
profile PASS 不能替代。任一轮出现 `BROWSER_CONTEXT_CLOSED`、`SINGLE_PAGE_CONTEXT_REQUIRED` 或 raw/legacy
Target-closed 错误都应停止，且不得继续 rehearsal/live。`dry-run` 只读取官方页面控件，不点击“立即购票”、
场次、票档、数量、观演人或提交控件。两轮结束后，默认 sandbox 必须仍为 `0700`，默认 sandbox/live
profile 都不得残留 `.ticket-agent.runner.lock`；只读检查方法以 README D 节为准，发现 lock 时不得自动删除。

## 3. 初始化 live 专用登录会话

可以在没有活动链接时先打开大麦首页，使用 live 专用 profile 手动完成登录和账号安全验证：

```bash
npm run build
npm run start:runner -- --login-only \
  --platform damai \
  --url https://www.damai.cn/
```

`login-only` 只打开可见浏览器，不读取购票计划，不选择票档，也不提交订单。完成登录后关闭整个 TicketAgent
浏览器或在终端按 `Ctrl-C`；若只关闭新登录标签而其他恢复页仍在，runner 与 profile lock 会继续等待。会话只
保存在 Mac 的 live 专用 profile。该模式不代表大麦适配器已经达到 `liveReady`，猫眼目前也不支持此模式。
不要把 `--plan`、`--controller-url`、`--run-id` 或 `--confirm-live` 与它组合。

## 4. 在 macOS Keychain 配置观演人映射

先在大麦账号的可见页面中由用户本人维护实名观演人。项目计划中只保存不含语义的
`attendee:v1:<UUIDv4>` 引用，页面上可见的观演人名称只在 T-10 预热窗口内从 Mac Keychain
读入进程内存。

使用「钥匙串访问」GUI 新建「密码项」，每个观演人建立一项：

- 钥匙串：选择当前 Mac 用户的登录钥匙串。
- 名称/Service：大麦固定使用 `com.ticket-agent.attendee.damai`。
- 账户名/Account：使用计划里同一个 `attendee:v1:<UUIDv4>` opaque ref。
- 密码/Password：只填大麦页面上可见、用于唯一匹配的观演人名称。

不要在终端中用 `security add-generic-password` 写入姓名，否则可能进入 shell history。
不要把身份证号、账号密码、Cookie、短信码或支付信息放入 Keychain 的该项、计划文件或仓库。
若项目计划里有一个 `attendeeRef`，但 Keychain 中没有唯一对应项，live/rehearsal 会在打开浏览器前
fail-closed；dry-run/mock 永远不读取 Keychain。

旧版本 SQLite 中若存在明文 `attendeeAliases`，新版本会擦除该字段、关闭自动提交并暂停计划；关联的
全部非终态 run 会在同一迁移事务中进入 `FAILED`。已有 `HELD` 购买锁不会自动释放，用户必须先核对
官方订单；随后重新用 opaque refs 登记观演人并创建/武装安全计划。

## 5. 无身份 selector 校准（无提交能力）

以下是后续 rehearsal 流程，不是当前基础复验指令。当前 HEAD 已在官方导航前安装 listener-first
sticky topology guard，并用合成故障矩阵覆盖 popup/新页、原页关闭、context 关闭、初始多页和
dispose 清理；在真实 selector/确认页 contract、用户私有约束和单独执行指令具备前，仍不得运行本节命令。

登录完成后，可使用同一个可见 live 专用 profile 检查活动身份、页面边界和基础 selector：

```bash
npm run build
npm run start:runner -- --rehearsal --confirm-rehearsal \
  --plan examples/damai-iwwf-readonly-plan.json \
  --url 'https://detail.damai.cn/item.htm?id=1067493715985'
```

`rehearsal` 只接受与计划一致的大麦官方 HTTPS 活动地址。它不连接控制器，不接受
`--controller-url`/`--run-id`/`--confirm-live`，安全策略也不具备 submit 授权和
`submitOrder` 能力；即使计划误设为自动提交，成功演练也必须停在 `REVIEW_REQUIRED`。
它允许 `liveReady=false` 的已实现大麦适配器运行，以便校准真实页面；选择器尚未匹配、
页面出现验证码或跳出官方域名时，会更早 fail-closed，不代表发生过提交。
它不会丢弃 live profile 中的非空 restored page；发现此类页面时会要求用户复核并停止。
计划至少必须绑定 `officialUrl` 和 `eventId`，且 `--url` 若出现必须与 `officialUrl` 完全相同；校准阶段
可以暂缺尚未审核的标题，但不得用无活动身份的空计划执行可逆点击。

这里使用的仓库示例是无身份只读校准计划：`attendeeRefs`、`sessions` 和 `tiers` 都为空，且
`autoSubmitOrder=false`。因此该命令不会读取 Keychain、不会选择观演人，也不能证明指定场次、票档、
数量、预算和观演人的完整确认页演练已经通过。

完整无提交 rehearsal 必须在 Mac 上另建不进入仓库的私有计划，至少包含用户批准的官方活动
URL/ID、已核准活动标题、场次顺序、票档顺序、数量、明确 `maxTotalFen`、`PREFERRED_ORDER` 以及与
数量一致的 opaque `attendeeRefs`；对应的页面可见观演人名称只放在 Keychain 映射中，不能写入计划、
示例或仓库。
`autoSubmitOrder` 仍设为 `false`，然后使用该私有计划执行：

```bash
npm run build
npm run start:runner -- --rehearsal --confirm-rehearsal \
  --plan /absolute/path/damai-private-rehearsal-plan.json \
  --url '与私有计划 officialUrl 完全相同的官方 HTTPS 地址'
```

只有这项私有计划演练才能校准并复核活动、场次、票档、数量、观演人、总价和 submit readiness；它仍
没有 controller/capability，也不会提交订单。

注意：当前 `rehearsal` 使用的是可逆的 legacy adapter 路径。即使它停在 `REVIEW_REQUIRED`，也不能
证明尚未配置的 `FastPathContract` 在同一页面上可用；进入 live 前必须先生成脱敏、版本化的真实
selector/evidence contract，并让无提交验收使用与 live 完全相同的 contract/digest。

## 6. 获得大麦官方链接后

1. 把官方 HTTPS 活动链接、准确活动标题/ID 和开售时间写入计划。校准计划可先只绑定活动 ID；
   在真实标题 selector 审核通过前不要伪造 `eventTitle`，正式 live 计划必须同时绑定 ID 和标题。
2. 先用 `dry-run` 做只读页面分析，记录实际可见的场次、票档、总价和页面状态；不提供账号密码、Cookie、身份证或支付信息。
3. 根据真实页面更新并审核大麦 selector，完成页面改版、验证码、重定向和价格歧义测试。
4. 用第 5 节所述本机私有计划执行完整 `rehearsal`，演练到订单确认页并核对活动、场次、票档、数量、
   观演人和总价；仓库内无身份示例不能替代这一步。
5. 设置明确的 `maxTotalFen`、场次优先级和票档优先级；生成版本化 fast-path contract，并确认 adapter
   中的 contract digest 完全匹配。只有全量回归和 Mac 三轮性能门通过后，才允许同时将大麦
   `liveReady` 与 `fastPathReady` 改为 `true`。

## 7. 真实执行时的强制条件

- `--live` 与 `--confirm-live` 同时出现；
- 使用 `--controller-url http://127.0.0.1:4317` 和控制器生成的 `--run-id`；
- plan 来自控制器，不能用本地文件替换；
- plan 必须包含带明确时区的 `saleAt`；它同时作为一次性 capability 的签名最早提交时间；
- plan 必须显式使用 `PREFERRED_ORDER`，包含非空场次/票档顺序、观演人 refs 和 `maxTotalFen`；
- adapter 的 `liveReady`、`fastPathReady`、contract 和 contract digest 四者同时通过；
- 默认 sandbox 两轮 dry-run、启动生命周期修复和合成性能基准都不能替代真实 selector 与确认页 contract
  审核；导航前 sticky topology guard 已作为代码/回归门接入，但仍需在 Mac 基础回归中确认版本一致；不得
  仅凭这些结果解除 readiness；
- 浏览器 resident ACK 成功后，controller 才在首次 capability delivery 事务中取得活动购买锁；
- 本机 prepare 与 prepared ACK 成功后才允许运行 fast path；最终可见价格必须与 capability 和 DOM
  证据逐分相同；
- 点击后保持可见 Chrome 供用户核对订单并支付；`CLICK_DISPATCHED` 不等于购票成功。

Controller 与 Mac runner 都需要同一把独立 capability key；它必须与 Bearer token 不同且至少 32
UTF-8 字节。不要把值写入 shell 脚本、仓库或计划文件。示意配置如下，实际部署应放入权限受限的
本机环境/Secret 管理：

```bash
export TICKET_AGENT_TOKEN='至少32字节的controller bearer token'
export TICKET_AGENT_CAPABILITY_KEY='另一把至少32字节的capability key'
```

Runner 读取 capability key 后立即从自身环境删除该条目，完成 `prepare()` 后清零内存 buffer。

距离 `saleAt` 超过 10 分钟时，CLI 协调器保持运行，每 30 秒确认控制器 run 仍为 `SCHEDULED`，但不会
打开 live Chrome profile；进入 10 分钟预热窗口后才打开可见页面。它先等待 resident ACK，再领取
唯一 capability；领取事务会把 run 从 `SCHEDULED` 转入 `PREWARM`。官方队列可见时，同一 observer
只等待 DOM 变化，不刷新、不并发开页，也不绕过队列。Mac 和终端必须保持运行；首次 delivery 响应
丢失、ACK 失败、中断或点击结果未知后都禁止重新领取/重新点击，必须人工核对 durable grant 和官方订单。

若授权后页面或价格变化，执行器停止且购买锁保持，必须由用户检查官方订单历史后才能显式释放。
