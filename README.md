# Ticket Agent

大麦优先、猫眼预留的 macOS 本地购票辅助智能体。它只通过官方网页的可见控件工作；遇到
验证码、风控、登录异常、价格/页面歧义、未知提交结果或支付确认时停止并交给用户。

> **公开冻结版 `v0.1.0`（2026-08-03）**
>
> 当前 `liveReady=false`、`fastPathReady=false`。真实大麦 selector 和确认页 contract 尚未
> 完成维护者审核，猫眼适配器继续 fail-closed。本版本不是可直接用于无人值守抢票或自动
> 支付的成品，合成 benchmark 也不代表真实库存、排队、风控或购票成功率。

English summary: a local, fail-closed macOS browser assistant for official ticketing pages. The
public release is not live-ready and does not bypass CAPTCHA, identity checks, risk controls, or
payment confirmation.

## 当前能力

- 大麦适配器骨架和猫眼 fail-closed 占位，二者不共享 selector 或账号会话；
- 活动/官方域名绑定、明确预算、场次/票档/数量/观演人证据和不可变价格快照；
- 单实例 profile 锁、跨平台重复购买锁、一次性提交 capability 和未知结果不重试；
- 导航前 sticky page-topology guard，以及 popup/新页/原页关闭/context 关闭的零点击阻断；
- macOS live/sandbox Chrome profile 隔离，opaque attendee refs 只在本地 Keychain 解析；
- contract-driven 无提交演练、脱敏报告、mock smoke 和本地延迟基准。

## 明确边界

本项目不实现私有 API 逆向、验证码或人脸验证破解、代理池、多账号并发、设备指纹伪造、
平台限购绕过或自动支付。登录、短信/人脸验证、验证码和支付必须由用户本人在可见 Chrome
中完成。页面或价格不明确时，正确结果是停止，而不是猜测点击。

请先确认当地法律、目标平台条款和活动规则允许你的使用方式。库存和官方队列由平台控制，
本项目不保证取得门票。

## 快速开始

要求 Node.js 22.13 或更高版本。以下命令只构建代码并访问测试/mock/loopback，不会登录、
选票、提交订单或读取 Keychain：

```bash
git clone https://github.com/chaoyu-fan/ticket-agent.git
cd ticket-agent
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
```

真实浏览器执行只支持用户自己的 Mac，并要求安装 Google Chrome：

```bash
bash scripts/setup-macos.sh
```

不要使用日常 Chrome profile。Ticket Agent 默认把 live 和 sandbox profile 分开保存，限制为
`0700`，并拒绝符号链接和并发 runner。

## 给 macOS Agent 的交接

新 agent 打开仓库后先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)。当前唯一授权的首轮动作是安全
拉取和本地验收，不是实盘下单：

```bash
set -euo pipefail
cd "${TICKET_AGENT_DIR:-$HOME/ticket-agent}"
[ -z "$(git status --short)" ] || { git status --short; exit 1; }
[ "$(git branch --show-current)" = main ] || exit 1
git pull --ff-only origin main
git fetch --tags origin
git merge-base --is-ancestor v0.1.0 HEAD
npm ci --ignore-scripts
bash scripts/setup-macos.sh
npm run check
TMPDIR=/private/tmp npm test
npm run smoke
git status --short
```

最后一条必须没有输出。任何一步失败都停止；不得 `reset`、`clean`、删除 profile/lock、执行
`--live`，也不得修改 readiness。只回传脱敏的 HEAD、版本和 check/test/smoke 结果。

后续真实页面校准还需要用户明确提供官方活动 URL/ID/标题、数量、`maxTotalFen`、场次/票档
顺序、连座要求和 Mac 本地 opaque attendee refs。信息完整后也只先制作仓库外 `0600` 的私有
plan/contract，并按 [`docs/CONTRACT_REHEARSAL.md`](docs/CONTRACT_REHEARSAL.md) 做无提交演练；
三轮通过不会自动开启 readiness。

## 运行模式

| 模式 | 边界 | 当前状态 |
| --- | --- | --- |
| `mock` | 仅 loopback fixture，永不提交 | 可用于测试 |
| `dry-run` | sandbox profile，只读/零点击 | 可用于人工校准 |
| `login-only` | live 专用可见 Chrome，只允许用户手工登录 | 可用于准备会话 |
| `contract-rehearsal` | 可逆选择 + 不可逆 click/form shield，无 controller/capability | 待真实 contract 校准 |
| `live` | resident fast path + 一次性 capability | 被 readiness 强制阻断 |

## 文档

- [macOS 最短交接](docs/HANDOFF.md)
- [macOS 完整手册](docs/MACOS.md)
- [contract 无提交演练](docs/CONTRACT_REHEARSAL.md)
- [安全模型](docs/SECURITY.md) 和 [漏洞报告](SECURITY.md)
- [快路径设计](docs/FAST_PATH.md) 与 [性能口径](docs/PERFORMANCE.md)
- [提交 capability](docs/SUBMIT_CAPABILITY.md)
- [实施计划](docs/PLAN.md) 与 [冻结发布记录](docs/RELEASE.md)
- [变更记录](CHANGELOG.md)

## 数据与隐私

不要向仓库、issue、聊天或日志提交 Cookie、账号密码、身份证信息、短信码、支付信息、
Keychain 值、Chrome profile、页面 HTML、私有 plan/contract 或 raw benchmark JSON。
`.gitignore` 已覆盖常见本地敏感文件，但它不能替代提交前审查。

## 贡献与许可

提交前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。公开仓库采用 [MIT License](LICENSE)。
`package.json` 保留 `private:true` 只用于阻止误发 npm registry，不影响 GitHub 源码许可。
