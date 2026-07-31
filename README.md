# Ticket Agent

个人购票辅助智能体，大麦优先、猫眼随后接入。它只通过官方网页的可见控件工作；遇到验证码、风控、登录异常、未知页面或支付确认时停止并交给用户。

## 给 macOS Agent 的交接（从这里开始）

如果你是在用户 Mac 上接手本仓库的 agent，当前任务不是立即实盘下单，而是先验收已推送的
常驻低延迟快路径，再进行无提交的真实大麦页面校准。功能基线提交为 `d0e8e77`；文档提交可能使
`main` 的 HEAD 更新，但当前 `main` 必须包含该基线。仓库固定为
`https://github.com/chaoyu-fan/ticket-agent.git` 的 `main` 分支。

**本轮只执行 A–D、遵守 E，并按 F 回传。** 完成后必须停止并回传报告；不要启动 controller、创建或武装实盘计划，
不要执行 `--live`，也不要自行修改 readiness 开关。本节后面的 controller/live 说明只是后续设计文档，
不是本轮执行指令。

### 交接目标

1. 安全地拉取最新 `main`，不覆盖 Mac 上任何未提交改动。
2. 在 Mac 的真实 Google Chrome 环境通过构建、全量测试、mock smoke 和四类性能基准。
3. 只在上述验收通过后，执行大麦真实页的 `dry-run` 或无提交 `rehearsal`。
4. 把规定的脱敏证据回传给用户；不得将 Cookie、姓名、证件、Chrome profile 或页面 HTML 上传到 GitHub。

### A. 拉取前检查

默认 Mac 项目目录是 `/Users/jakefan/ticket-agent`。如果目录已存在：

```bash
set -e
cd /Users/jakefan/ticket-agent
if [ -n "$(git status --short)" ]; then
  echo '工作树有未提交改动，停止：' >&2
  git status --short
  exit 1
fi
branch="$(git branch --show-current)"
if [ "$branch" != main ]; then
  echo "当前分支不是 main：$branch" >&2
  exit 1
fi
verify_ticket_agent_origin() {
  local raw normalized
  raw="$(git remote get-url origin 2>/dev/null)" || {
    echo 'origin 缺失或不可读取' >&2
    return 1
  }
  normalized="${raw%/}"
  normalized="${normalized%.git}"
  case "$normalized" in
    https://github.com/chaoyu-fan/ticket-agent|\
    https://github.com:443/chaoyu-fan/ticket-agent|\
    git@github.com:chaoyu-fan/ticket-agent|\
    git@ssh.github.com:chaoyu-fan/ticket-agent|\
    ssh://git@github.com/chaoyu-fan/ticket-agent|\
    ssh://git@github.com:22/chaoyu-fan/ticket-agent|\
    ssh://git@github.com:443/chaoyu-fan/ticket-agent|\
    ssh://git@ssh.github.com:443/chaoyu-fan/ticket-agent)
      echo "origin 已验证：$raw"
      ;;
    *)
      echo "origin 不是 ticket-agent GitHub 仓库：$raw" >&2
      return 1
      ;;
  esac
}
verify_ticket_agent_origin
```

只有工作树为空、当前分支为 `main` 且上述校验确认 `origin` 指向 `ticket-agent` 仓库时才继续；已有合法 SSH origin 不需要改写。
如果有任何改动，或任一检查失败，
不要执行 `reset`、`clean`、`checkout --` 或覆盖文件；立即停止并向用户报告具体输出。全部通过后执行：

```bash
git pull --ff-only origin main
git merge-base --is-ancestor d0e8e77 HEAD
git log -1 --oneline
```

`git merge-base` 必须返回 0。如果项目目录不存在，才执行全新 clone：

```bash
set -e
cd /Users/jakefan
git clone https://github.com/chaoyu-fan/ticket-agent.git
cd ticket-agent
branch="$(git branch --show-current)"
[ "$branch" = main ] || { echo "clone 后当前分支不是 main：$branch" >&2; exit 1; }
origin_url="$(git remote get-url origin)"
case "$origin_url" in
  https://github.com/chaoyu-fan/ticket-agent|https://github.com/chaoyu-fan/ticket-agent.git) ;;
  *) echo "clone 后 origin 不是 ticket-agent GitHub 仓库：$origin_url" >&2; exit 1 ;;
esac
git merge-base --is-ancestor d0e8e77 HEAD
```

### B. Mac 基础验收

前置条件是 macOS、Node.js `22.13+` 和已安装的 Google Chrome。不要使用日常 Chrome profile，不要将账号密码、
Cookie、身份证号或支付信息写入终端、计划文件或仓库。按顺序执行：

```bash
npm ci --ignore-scripts
bash scripts/setup-macos.sh
npm run check
TMPDIR=/private/tmp npm test
npm run smoke
sw_vers -productVersion
node --version
npm --version
"${TICKET_AGENT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" --version
```

验收标准：

- `setup-macos.sh` 的 Chrome、路径隔离和符号链接预检成功；该脚本不会创建 profile，runner 首次使用时才会安全创建并设为 `0700`；
- `npm run check` 成功；
- 当前基线的测试应为 `252/252` 通过；
- `npm run smoke` 应为 `7/7` mock 场景通过。

### C. Mac 性能验收

四类基准各连续执行三轮，每轮固定 50 次预热和 500 次正式采样：

```bash
set -e
bench_dir="$(mktemp -d /private/tmp/ticket-agent-bench.XXXXXX)"

for run in 1 2 3; do
  npm run --silent benchmark:loopback \
    > "$bench_dir/loopback-performance-$run.json"
  npm run --silent benchmark:state-machine \
    > "$bench_dir/state-machine-performance-$run.json"
  npm run --silent benchmark:trusted-click \
    > "$bench_dir/trusted-click-performance-$run.json"
  npm run --silent benchmark:armed-fast-path \
    > "$bench_dir/armed-fast-path-performance-$run.json"
done

git status --short
```

所有命令必须返回 0。`armed-fast-path` 的三份报告还必须满足：

- `sampleIterations=500`；
- `exactTargetBound`、`priceChanged`、`evidenceChangedAfterHandle`、`detachedHandle`、
  `obscuredTarget`、`disabledTarget` 六项 `faultChecks` 全部为 `1`；
- hot path p95/p99 不超过 `100/125 ms`；
- trusted click p95/p99 不超过 `75/100 ms`；
- `t0ToTrustedClickLatencyMs` p95/p99 不超过 `125/150 ms`。

`loopback`、`trusted-click` 和 `armed-fast-path` 命令会在进程内校验各自的固定性能门；`state-machine`
只校验封闭报告结构和状态机语义，没有人为设定的固定延迟门，因此只记录三轮实测摘要，不宣称“过性能门”。
这些 JSON 只保存在 Mac 的私有 `/private/tmp` 临时目录，不得复制进仓库或整份上传。最后的
`git status --short` 必须仍为空。报告只回传下面 F 节要求的聚合值；合成结果不能解释为真实大麦购票成功率。

### D. 真实大麦页面的无提交校准

只有 A–C 全部通过后才能执行本阶段。先运行零点击 `dry-run`：

```bash
npm run build
npm run start:runner -- --dry-run \
  --plan examples/damai-iwwf-readonly-plan.json
```

该例只用于低热度页面身份和 selector 校准。它的 `attendeeRefs`、`sessions` 和 `tiers` 为空，
`autoSubmitOrder=false`，不读 Keychain、不选观演人、不提交订单。停在 `PAGE_CHANGED` 或缺少唯一总价可以是预期的
校准结果。

如果用户明确要求准备登录，agent 只负责打开 live 专用可见 Chrome；账号、密码、短信或人脸验证均由用户本人在
浏览器里完成，不得让用户粘贴到终端或聊天。完成登录后由用户关闭浏览器，或在终端按 `Ctrl-C`：

```bash
npm run start:runner -- --login-only \
  --platform damai \
  --url https://www.damai.cn/
```

`login-only` 不读取计划、不选择票档且没有下单能力。只有用户确认已完成登录，并再次明确要求继续无提交演练，
agent 才可执行：

```bash
npm run start:runner -- --rehearsal --confirm-rehearsal \
  --plan examples/damai-iwwf-readonly-plan.json \
  --url 'https://detail.damai.cn/item.htm?id=1067493715985'
```

`rehearsal` 模式可以操作计划中明确列出的可逆选项，但在代码层没有 controller/capability 和 submit 权限。
当前仓库示例的场次、票档和观演人均为空，因此本轮仍只是页面校准，不是完整确认页演练。没有用户明确提供的
`maxTotalFen`、场次/票档顺序、数量和 Mac 本地私有计划时，不得猜测或补造这些字段。遇到 CAPTCHA、短信/人脸验证、
登录异常、页面改版或跳出官方域名时，停止并交给用户，不得尝试绕过。

runner 执行后只核对已实际创建的 profile 权限；`NOT_CREATED` 不是失败，表示本轮没有使用该 profile：

```bash
set -e
check_profile_mode() {
  local label="$1" path="$2" mode
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
    echo "$label: FAIL"
    return 1
  fi
  if [ ! -e "$path" ]; then
    echo "$label: NOT_CREATED"
    return 0
  fi
  mode="$(stat -f '%OLp' "$path")" || { echo "$label: FAIL"; return 1; }
  [ "$mode" = 700 ] || { echo "$label: FAIL(mode=$mode)"; return 1; }
  echo "$label: 700"
}
check_profile_mode sandbox "${TICKET_AGENT_SANDBOX_PROFILE:-$HOME/Library/Application Support/TicketAgent/SandboxChromeProfile}"
check_profile_mode live "${TICKET_AGENT_PROFILE:-$HOME/Library/Application Support/TicketAgent/ChromeProfile}"
git status --short
```

凡已创建的 profile，mode 必须为 `700`；最终 `git status --short` 必须为空。

### E. 必须保持的禁止项

- 不得把大麦 `liveReady` 或 `fastPathReady` 改为 `true`；猫眼也继续 fail-closed。
- 不得执行 `--live`，除非真实确认页 contract 已审核、Mac 演练已通过，且用户明确提供
  `maxTotalFen`、场次顺序、票档顺序、数量和提交确认。
- 不得添加私有 API、验证码解答、代理池、多账号/多页并发、指纹伪装、坐标点击、`force:true` 或高频刷新。
- Cookie、实名信息、Keychain 值、Chrome profile 和支付只能留在 Mac。
- 如果 capability 已领取、点击结果未知或存在 `HELD` lock，不得自动重试；先让用户检查官方订单。

### F. 回传给用户的固定报告

Mac agent 完成后应使用以下结构回复，不得包含 token、Cookie、观演人姓名、页面 HTML 或 profile 路径内容：

```text
HEAD: <git rev-parse --short HEAD>
worktree: clean | dirty (dirty 时列文件名，不覆盖)
macOS / Node / npm / Chrome: <版本>
setup-macos: PASS | FAIL
check: PASS | FAIL
tests: <passed>/<total>
smoke: <passed>/<total>
benchmark loopback runs 1-3: <各轮 gate 结果和 p50/p95/p99>
benchmark state-machine runs 1-3: <各轮 exit=0 和 p50/p95/p99；无固定 latency gate>
benchmark trusted-click runs 1-3: <各轮 gate 结果、p50/p95/p99 和 faultChecks>
benchmark armed-fast-path runs 1-3: <各轮 hot/trusted-click/T0-to-click 的 p50/p95/p99 和六项 faultChecks>
dry-run: NOT_RUN | <state, observed total if present, zero-click confirmation>
rehearsal: NOT_RUN | <state, zero-submit confirmation>
liveReady / fastPathReady: false / false
profile path isolation preflight: PASS | FAIL
sandbox / live profile mode: 0700 | NOT_CREATED | FAIL / 0700 | NOT_CREATED | FAIL
secrets or identity data persisted/uploaded: NO | YES
raw benchmark JSON uploaded or added to repo: NO | YES
blockers: <none or exact blocker>
```

定义完成：仓库包含 `d0e8e77`，工作树干净，基础验收通过，12 条基准命令全部返回 0、12 份报告结构和语义有效，
有固定性能门的三类基准全部过门，且 armed fast path 的六项 fault check 全为 1；`state-machine` 只记录三轮实测摘要。
整个过程不得打开任何 live 开关。未完成的真实大麦 selector/confirmation contract 校准必须如实列为 blocker，不能把
合成基准描述为真实购票就绪。

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
