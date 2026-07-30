# Ticket Agent

个人购票辅助智能体，大麦优先、猫眼随后接入。它只通过官方网页的可见控件工作；遇到验证码、风控、登录异常、未知页面或支付确认时停止并交给用户。

## 当前状态

- 控制器、SQLite 审计、macOS Chrome 执行器和本地 mock 已完成。
- 开售协调器会在远期保持 `SCHEDULED`，进入 10 分钟预热窗口后打开可见页面，并在同一官方队列页串行等待。
- 已取得并验证一个低热度大麦官方活动链接，专用只读计划位于
  `examples/damai-iwwf-readonly-plan.json`；真实页面 selector 和确认页尚未审核，
  因此 `liveReady` 继续固定为 `false`。
- 开售/官方队列等待已改为页面内 `MutationObserver` 主触发；浏览器驻留选择状态机和 T-10
  一次性提交能力已经接成 durable controller → Mac runner → resident browser 的完整链路；精确
  ElementHandle 可信点击、驻留 ACK、响应丢失、精确目标/证据变化/脱离/遮挡/disabled 门，以及
  常驻期间新页、popup 或原页关闭的粘滞零点击防线均有回归测试。
  `--live` 只能走该 fast path，不能回退旧 `LocalRunner`。但大麦真实 selector contract 尚未校准，
  所以 `liveReady=false`、`fastPathReady=false` 仍保持关闭。隔离性能基准只表示本机理想下限，不能
  当作真实端到端购票延迟或成功率。
- 猫眼适配器目前是 fail-closed 占位，不会猜测复用大麦选择器。
- 当前默认值为 1 张、可见允许票档中最低价优先；热门活动的极速配置应改用
  `PREFERRED_ORDER`，按用户预先批准的票档顺序命中即走。未设置 `maxTotalFen` 时禁止自动提交。
  自动提交还必须绑定带时区的 `saleAt`；该时间会成为一次性能力的签名最早提交门。

账号会话和 Chrome profile 只留在用户 Mac。本项目不保存或上传密码、Cookie、身份证号和支付信息。

## 验证工程

需要 Node.js 22.13 或更高版本：

```bash
npm ci
npm run check
npm test
npm run smoke
npm run --silent benchmark:loopback
npm run --silent benchmark:state-machine
npm run --silent benchmark:trusted-click
npm run --silent benchmark:armed-fast-path
```

没有活动链接时，可以进行纯配置检查；它不会启动浏览器或访问网络：

```bash
npm run build
npm run start:runner -- --dry-run --plan examples/default-damai-plan.json
```

在 Mac 上对当前校准活动进行零点击真实页检查：

```bash
npm run build
npm run start:runner -- --dry-run \
  --plan examples/damai-iwwf-readonly-plan.json
```

真实详情页没有订单总价时，安全停止在 `PAGE_CHANGED` 是预期结果；这用于确认需要校准的
页面证据，不会开启选票或下单。

## macOS 运行边界

在 Mac 安装 Google Chrome 后运行：

```bash
bash scripts/setup-macos.sh
```

真实 live/rehearsal 模式和 mock/dry-run 使用两个隔离的 Chrome profile。目录拒绝符号链接、权限限制为 `0700`，并通过原子锁阻止同一 profile 同时运行两个执行器。live 与 rehearsal 都强制显示浏览器，以便验证码或登录时人工接管；rehearsal 在代码层面没有控制器授权和订单提交能力。

本机控制器只监听 loopback。Bearer token 与 capability HMAC key 都至少 32 UTF-8 字节，且必须不同：

```bash
export TICKET_AGENT_TOKEN="$(openssl rand -hex 32)"
export TICKET_AGENT_CAPABILITY_KEY="$(openssl rand -hex 32)"
npm run build
npm run start:controller
```

Mac runner 需要配置与 controller 相同的 `TICKET_AGENT_CAPABILITY_KEY`，并继续使用 Bearer token 访问
controller。key 只在 T-10 内存中验证首次交付的 envelope，prepare 后立即清零；不会写入 SQLite、
日志或浏览器。真实 runner 必须从控制器读取已武装 run，等待浏览器驻留 ACK 后只领取一次 capability，
prepared ACK 成功后才允许本机消费和可信点击。普通 runner 事件不能伪造 `SUBMIT_ORDER` 或 `SUCCESS`。
在大麦 adapter 的真实 contract 完成审核前，CLI 会拒绝 live 启动。

详细的 macOS 流程见 [docs/MACOS.md](docs/MACOS.md)，安全约束见 [docs/SECURITY.md](docs/SECURITY.md)。

## 重要边界

本项目不实现验证码破解、私有接口逆向、代理池、多账号并发、设备指纹伪造或绕过平台限购。成功率由库存和官方队列决定；“极速”仅指压低 Mac 本地可控延迟，工程目标仍包括预算不越界、不重复提交、状态可审计并且随时能够人工接管。
