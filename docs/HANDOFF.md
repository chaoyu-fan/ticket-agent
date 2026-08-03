# macOS 交接入口

这份文档是公开仓库的最短交接路径；详细背景和故障处理仍见
[`README.md`](../README.md)、[`docs/MACOS.md`](MACOS.md) 和
[`docs/CONTRACT_REHEARSAL.md`](CONTRACT_REHEARSAL.md)。

## 当前冻结状态

- 发布线：`v0.1.0`（以仓库标签指向的提交为准）。
- 平台：大麦优先；猫眼适配器存在但保持 fail-closed。
- `liveReady=false`、`fastPathReady=false`。
- 当前公开验收只包含构建、单测和 mock；不代表真实库存或成功率。
- 登录、验证码、短信/人脸验证和支付必须由用户在可见 Chrome 中完成。

## Mac 首轮验收

把 `TICKET_AGENT_DIR` 设为本机 clone 路径（默认 `$HOME/ticket-agent`）。目录不存在时才 clone；
目录已存在时先验证工作树、分支和 origin，任何失败都停止：

```bash
set -euo pipefail
ticket_dir="${TICKET_AGENT_DIR:-$HOME/ticket-agent}"
if [ ! -e "$ticket_dir" ]; then
  git clone https://github.com/chaoyu-fan/ticket-agent.git "$ticket_dir"
fi
cd "$ticket_dir"
[ -d .git ] || { echo '目标不是 Git 仓库' >&2; exit 1; }
[ -z "$(git status --short)" ] || { git status --short; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo '当前分支不是 main' >&2; exit 1; }
origin_url="$(git remote get-url origin)"
normalized="${origin_url%/}"
normalized="${normalized%.git}"
case "$normalized" in
  https://github.com/chaoyu-fan/ticket-agent|https://github.com:443/chaoyu-fan/ticket-agent|\
  git@github.com:chaoyu-fan/ticket-agent|git@ssh.github.com:chaoyu-fan/ticket-agent|\
  ssh://git@github.com/chaoyu-fan/ticket-agent|ssh://git@github.com:22/chaoyu-fan/ticket-agent|\
  ssh://git@github.com:443/chaoyu-fan/ticket-agent|ssh://git@ssh.github.com:443/chaoyu-fan/ticket-agent) ;;
  *) echo "origin 不是官方仓库：$origin_url" >&2; exit 1 ;;
esac
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

最后一条必须没有输出。不要执行 `--live`、不要修改 readiness、不要把任何私有文件上传
到 GitHub。失败即停并回传命令、提交、错误类别和是否产生 profile/lock；不要 `reset`、`clean`
或删除 profile。

## 继续校准所需输入

只有用户明确提供以下约束，维护者才会安排真实页面的只读校准：

1. 官方 HTTPS 活动链接、准确活动 ID/标题和平台；
2. 数量、`maxTotalFen`、场次优先级、票档优先级和连座要求；
3. Mac 本地的 opaque `attendee:v1:<UUIDv4>` refs（姓名、证件号和 Keychain label 不进仓库）。

校准结果写入仓库外权限 `0600` 的 plan/contract，使用同一 live profile 连续三轮
`--contract-rehearsal` 无提交演练。第一轮出现验证码、登录失效、页面拓扑/主文档变化、价格或
selector 歧义即停止；三轮通过也不会自动打开 `liveReady` 或 `fastPathReady`。

## 回传格式

请只回传脱敏摘要：HEAD、Node/npm/Chrome 版本、check/test/smoke 结果、模式、readiness、
profile 权限和 lock 状态。不要回传 raw JSON、页面 HTML、Cookie、Keychain、身份或支付信息。
