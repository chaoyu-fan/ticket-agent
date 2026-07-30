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
```

前三轮是 benchmark-only 的 DOM/假点击下限；中间三轮实际调用驻留状态机，覆盖 DOM mutation、场次、
票档、数量、合成观演人选择、总价复核和固定假 sink；最后三轮测量精确 ElementHandle 的非 force
可信点击，并验证脱离、遮挡和 disabled 时零点击。三种基准都只使用临时无登录 Chrome。前两种的
假点击为 `isTrusted=false`；第三种要求 `isTrusted=true`，但仍没有大麦真实选择器、状态机证据交接、
网络、队列、风控或订单响应，不能据此宣称真实购票达到相同延迟或解除 `liveReady=false`。

不要把日常 Chrome 的目录、其父目录或 `Default` profile 配给执行器；live 与 sandbox profile 也不能相同或互为父子目录。首次使用 live 专用 profile 时，账号登录、实名观演人维护和安全验证都由用户在可见浏览器中完成。

## 2. 只读配置检查

执行默认计划的只读检查：

```bash
npm run build
npm run start:runner -- --dry-run --plan examples/default-damai-plan.json
```

预期结果是 `REVIEW_REQUIRED`，且没有浏览器、网络请求或点击。

已经确认可访问的低热度校准活动使用独立计划，不覆盖通用默认计划：

```bash
npm run build
npm run start:runner -- --dry-run \
  --plan examples/damai-iwwf-readonly-plan.json
```

该计划绑定大麦活动 ID `1067493715985`，固定为一张、最低价优先且
`autoSubmitOrder=false`。首次真实页检查可能以 `PAGE_CHANGED` 或“缺少唯一订单总价”停止；
详情页尚未进入选票/确认页时出现这一结果是预期的 selector 校准信号，不代表链接失效。
`dry-run` 只读取页面，不点击“立即购票”、场次、票档、数量或提交控件。

## 3. 初始化 live 专用登录会话

可以在没有活动链接时先打开大麦首页，使用 live 专用 profile 手动完成登录和账号安全验证：

```bash
npm run build
npm run start:runner -- --login-only \
  --platform damai \
  --url https://www.damai.cn/
```

`login-only` 只打开可见浏览器，不读取购票计划，不选择票档，也不提交订单。完成登录后关闭浏览器或在终端按 `Ctrl-C`；会话只保存在 Mac 的 live 专用 profile。该模式不代表大麦适配器已经达到 `liveReady`，猫眼目前也不支持此模式。不要把 `--plan`、`--controller-url`、`--run-id` 或 `--confirm-live` 与它组合。

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

## 5. 确认页演练（无提交能力）

登录完成后，可使用同一个可见 live 专用 profile 演练大麦的场次、票档、数量和观演人选择：

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
计划至少必须绑定 `officialUrl` 和 `eventId`，且 `--url` 若出现必须与 `officialUrl` 完全相同；校准阶段
可以暂缺尚未审核的标题，但不得用无活动身份的空计划执行可逆点击。

## 6. 获得大麦官方链接后

1. 把官方 HTTPS 活动链接、准确活动标题/ID 和开售时间写入计划。校准计划可先只绑定活动 ID；
   在真实标题 selector 审核通过前不要伪造 `eventTitle`，正式 live 计划必须同时绑定 ID 和标题。
2. 先用 `dry-run` 做只读页面分析，记录实际可见的场次、票档、总价和页面状态；不提供账号密码、Cookie、身份证或支付信息。
3. 根据真实页面更新并审核大麦 selector，完成页面改版、验证码、重定向和价格歧义测试。
4. 用上述 `rehearsal` 模式演练到订单确认页，核对活动、场次、票档、数量、观演人和总价。
5. 设置明确的 `maxTotalFen`；只有全量回归通过后才允许将大麦 `liveReady` 改为 `true`。

## 7. 真实执行时的强制条件

- `--live` 与 `--confirm-live` 同时出现；
- 使用 `--controller-url http://127.0.0.1:4317` 和控制器生成的 `--run-id`；
- plan 来自控制器，不能用本地文件替换；
- plan 必须包含带明确时区的 `saleAt`；它同时作为一次性 capability 的签名最早提交时间；
- 最终可见价格在授权前和授权后都与不可变快照逐分相同；
- 控制器已取得该活动的唯一购买锁；
- 点击后只有看到唯一订单号和待支付状态才进入 `PAY_REQUIRED`，支付仍由用户完成。

距离 `saleAt` 超过 10 分钟时，CLI 协调器保持运行，每 30 秒确认控制器 run 仍为 `SCHEDULED`，但不会打开 live Chrome profile；进入 10 分钟预热窗口后才打开可见页面，并保持页面到开售时间。若进入官方排队页，会在同一页面安装一个 `MutationObserver`，并使用本地 DOM fallback；每 2 秒的控制循环只检查取消和官方域名边界，不刷新、不并发开页，也不绕过队列。Mac 和终端必须保持运行；预热前按 `Ctrl-C` 会保留可重新启动的 `SCHEDULED`，预热后中断则先尝试把 run 记为 `FAILED` 再关闭 profile。

若授权后页面或价格变化，执行器停止且购买锁保持，必须由用户检查官方订单历史后才能显式释放。
