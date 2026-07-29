# Ticket Agent

个人购票辅助智能体，大麦优先、猫眼随后接入。它只通过官方网页的可见控件工作；遇到验证码、风控、登录异常、未知页面或支付确认时停止并交给用户。

## 当前状态

- 控制器、SQLite 审计、macOS Chrome 执行器和本地 mock 已完成。
- 开售协调器会在远期保持 `SCHEDULED`，进入 10 分钟预热窗口后打开可见页面，并在同一官方队列页串行等待。
- 大麦适配器完成了安全框架和仿真验证，但在拿到真实官方活动链接并审核页面前，`liveReady` 固定为 `false`。
- 猫眼适配器目前是 fail-closed 占位，不会猜测复用大麦选择器。
- 当前默认值为 1 张、可见允许票档中最低价优先；未设置 `maxTotalFen` 时禁止自动提交。

账号会话和 Chrome profile 只留在用户 Mac。本项目不保存或上传密码、Cookie、身份证号和支付信息。

## 验证工程

需要 Node.js 22.13 或更高版本：

```bash
npm ci
npm run check
npm test
npm run smoke
```

没有活动链接时，可以进行纯配置检查；它不会启动浏览器或访问网络：

```bash
npm run build
npm run start:runner -- --dry-run --plan examples/default-damai-plan.json
```

## macOS 运行边界

在 Mac 安装 Google Chrome 后运行：

```bash
bash scripts/setup-macos.sh
```

真实模式和 mock/dry-run 使用两个隔离的 Chrome profile。目录拒绝符号链接、权限限制为 `0700`，并通过原子锁阻止同一 profile 同时运行两个执行器。live 模式强制显示浏览器，以便验证码、登录或支付时人工接管。

本机控制器只监听 loopback，令牌至少 32 字节：

```bash
export TICKET_AGENT_TOKEN="$(openssl rand -hex 32)"
npm run build
npm run start:controller
```

真实 runner 必须从控制器读取已武装 run，并在最终价格复核后调用专用 `approve-submit`。普通 runner 事件不能伪造 `SUBMIT_ORDER` 或 `SUCCESS`。在大麦适配器完成真实页面审核前，CLI 会拒绝 live 启动。

详细的 macOS 流程见 [docs/MACOS.md](docs/MACOS.md)，安全约束见 [docs/SECURITY.md](docs/SECURITY.md)。

## 重要边界

本项目不实现验证码破解、私有接口逆向、代理池、多账号并发、设备指纹伪造或绕过平台限购。成功率由库存和官方队列决定；工程目标是预算不越界、不重复提交、状态可审计并且随时能够人工接管。
