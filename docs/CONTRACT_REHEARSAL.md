# 大麦 FastPathContract 校准与无提交交接

本页是 Mac 已完成 `026c7f4` 增量回归后的下一步操作清单。它只验证当前官方页面的 selection 与
submit-readiness selector/evidence，并对 post-submit selector 做 schema/CSS 语法审查；不会领取
controller capability、不会调用 `--live`，也不会点击提交/支付控件。

当前 contract/state machine 假设选择、总价和 submit-readiness 都在同一 canonical page/document 上完成。
如果大麦真实流程必须从详情页经过独立的可逆导航才能到确认页，contract rehearsal 应 fail-closed 并
回传 `CONTRACT_REHEARSAL_DOCUMENT_CHANGED` 或 `CONTRACT_REHEARSAL_FINAL_ORIGIN_MISMATCH`；不得靠
增加宽泛 selector、手动导航或猜测来绕过。此类流程需要维护者
先实现并审核 versioned staged contract，当前版本不提供该能力。

## 进入条件（缺一即停止）

Mac agent 先确认 README 顶部增量路径已经回传成功：旧回归报告为 `HEAD=026c7f4`、工作树干净，随后按
README 增量命令拉取至少包含 `d3d1963` 的最新 `main`，确认 `src/runner/contract-rehearsal.ts` 存在，并重新通过
`npm run check`、当前全量测试 `288/288` 和 `npm run smoke` `7/7`，同时保持
`liveReady=false / fastPathReady=false`。本阶段不需要重复四类 benchmark 或默认 sandbox dry-run；
如果增量回归失败，回到 README 的 A–F 路径，不要继续本页。

用户还必须在开始真实页面校准前明确提供（不要让 agent 猜测）：

- 官方大麦 HTTPS 活动 URL、活动 ID、准确标题和开售时间（若用于正式计划，时间必须带时区）；
- 购票数量（1–6）、明确最高总价 `maxTotalFen`（整数分）、是否要求连座；
- 场次优先顺序、票档优先顺序（热门活动使用 `PREFERRED_ORDER`）；
- 与数量一致的 Mac 本地 opaque `attendee:v1:<UUIDv4>` 引用及其唯一 Keychain 映射。

登录、短信/人脸验证、实名观演人维护和支付仍由用户在可见 Chrome 中完成。密码、Cookie、证件号、
Keychain label 和支付信息不得进入终端、计划、contract、日志或 GitHub。

## 两类本地文件

在仓库外（建议 `$HOME/Library/Application Support/TicketAgent/private/`）创建两个普通文件，
并限制为当前用户可读写：

```bash
umask 077
mkdir -p "$HOME/Library/Application Support/TicketAgent/private"
chmod 700 "$HOME/Library/Application Support/TicketAgent/private"
chmod 600 /absolute/path/damai-contract-rehearsal-plan.json
chmod 600 /absolute/path/damai-fast-path-contract.json
```

`damai-contract-rehearsal-plan.json` 使用现有 WatchPlan JSON 结构，至少填入
`platform=damai`、与目标完全相同的 `officialUrl`/`eventId`/`eventTitle`、非空且有序的
`sessions`/`tiers`、`quantity`、`maxTotalFen`、`priceStrategy=PREFERRED_ORDER`、数量相同的
opaque `attendeeRefs`、`requireAdjacent` 和 `autoSubmitOrder=false`。不要写入
`attendeeAliases`；rehearsal 会在 Mac T-10/运行期从 Keychain 短暂解析 label，结束后清零。
校准 plan 建议省略 `saleAt`；若填写未来开售时间，Keychain resolver 在 T-10 窗口前会按设计以
`ATTENDEE_RESOLUTION_TOO_EARLY` 停止。未来正式 live plan 仍须另行绑定准确、带时区的 `saleAt`；
无论是否填写，contract rehearsal 都不会获得提交能力。

下面只是**不可直接运行的字段骨架**。尖括号值必须由 Mac agent 在同一官方页面完成只读核对后替换；
不得猜测、复制旧页面 selector 或把示例值当作已审核证据。

私有 plan（只保存 opaque refs，不保存姓名）可按以下结构准备：

```json
{
  "platform": "damai",
  "officialUrl": "https://detail.damai.cn/item.htm?id=<EVENT_ID>",
  "eventId": "<EVENT_ID>",
  "eventTitle": "<EXACT_VISIBLE_EVENT_TITLE>",
  "quantity": 1,
  "requireAdjacent": false,
  "priceStrategy": "PREFERRED_ORDER",
  "maxTotalFen": 0,
  "sessions": [
    { "label": "<EXACT_SESSION_LABEL>", "priority": 0 }
  ],
  "tiers": [
    { "label": "<EXACT_TIER_LABEL>", "priority": 0, "maxUnitPriceFen": 0 }
  ],
  "attendeeRefs": ["attendee:v1:00000000-0000-4000-8000-000000000000"],
  "autoSubmitOrder": false
}
```

`maxTotalFen=0`、假 UUID 和尖括号文本仅用于说明字段，不能通过 Keychain/页面校验；运行前必须换成
用户明确批准的预算、场次/票档和真实 opaque refs。`attendeeRefs.length` 必须等于 `quantity`，
`sessions`/`tiers` 必须按优先级提供至少一项；不要添加 `attendeeAliases`。

私有 `FastPathContract` v1 骨架如下（所有 `<REVIEWED_...>` 都是必须替换的、故意无效的占位符；
示例 origin 只表示格式，也必须换成实际页面经核对的 canonical origin）：

```json
{
  "version": 1,
  "platform": "damai",
  "finalOfficialOrigin": "https://detail.damai.cn",
  "selection": {
    "platform": "damai",
    "allowedOrigins": ["https://detail.damai.cn"],
    "blockingPredicates": [
      { "key": "captcha-visible", "selector": "<REVIEWED_CAPTCHA_SELECTOR>" },
      { "key": "login-required-visible", "selector": "<REVIEWED_LOGIN_SELECTOR>" },
      { "key": "sold-out-visible", "selector": "<REVIEWED_SOLD_OUT_SELECTOR>" },
      { "key": "official-queue-visible", "selector": "<REVIEWED_QUEUE_SELECTOR>" }
    ],
    "eventTitleSelector": "<REVIEWED_EVENT_TITLE_SELECTOR>",
    "eventIdSelector": "<REVIEWED_EVENT_ID_SELECTOR>",
    "eventIdAttribute": "<REVIEWED_EVENT_ID_ATTRIBUTE>",
    "session": {
      "optionSelector": "<REVIEWED_SESSION_OPTION_SELECTOR>",
      "labelSelector": "<REVIEWED_SESSION_LABEL_SELECTOR>",
      "selectedSelector": "<REVIEWED_SESSION_SELECTED_SELECTOR>",
      "clickSelector": "<REVIEWED_SESSION_CLICK_SELECTOR>",
      "labelAttribute": "<REVIEWED_SESSION_LABEL_ATTRIBUTE>"
    },
    "sessionSummarySelector": "<REVIEWED_SESSION_SUMMARY_SELECTOR>",
    "tier": {
      "optionSelector": "<REVIEWED_TIER_OPTION_SELECTOR>",
      "labelSelector": "<REVIEWED_TIER_LABEL_SELECTOR>",
      "selectedSelector": "<REVIEWED_TIER_SELECTED_SELECTOR>",
      "clickSelector": "<REVIEWED_TIER_CLICK_SELECTOR>",
      "labelAttribute": "<REVIEWED_TIER_LABEL_ATTRIBUTE>",
      "priceTextSelector": "<REVIEWED_TIER_PRICE_TEXT_SELECTOR>",
      "priceFenAttribute": "<REVIEWED_TIER_PRICE_FEN_ATTRIBUTE>"
    },
    "tierSummarySelector": "<REVIEWED_TIER_SUMMARY_SELECTOR>",
    "quantity": {
      "summarySelector": "<REVIEWED_QUANTITY_SUMMARY_SELECTOR>",
      "select": { "controlSelector": "<REVIEWED_QUANTITY_CONTROL_SELECTOR>" }
    },
    "attendee": {
      "optionSelector": "<REVIEWED_ATTENDEE_OPTION_SELECTOR>",
      "labelSelector": "<REVIEWED_ATTENDEE_LABEL_SELECTOR>",
      "selectedSelector": "<REVIEWED_ATTENDEE_SELECTED_SELECTOR>",
      "clickSelector": "<REVIEWED_ATTENDEE_CLICK_SELECTOR>",
      "labelAttribute": "<REVIEWED_ATTENDEE_LABEL_ATTRIBUTE>"
    },
    "adjacencySelector": "<REVIEWED_ADJACENCY_SELECTOR>",
    "totalSelector": "<REVIEWED_TOTAL_SELECTOR>",
    "totalFenAttribute": "<REVIEWED_TOTAL_FEN_ATTRIBUTE>",
    "forbiddenActionSelectors": [
      "<REVIEWED_SUBMIT_SELECTOR>",
      "<REVIEWED_OTHER_IRREVERSIBLE_SELECTOR>"
    ]
  },
  "submitReadiness": {
    "selector": "<REVIEWED_SUBMIT_SELECTOR>",
    "labelSelector": "<REVIEWED_SUBMIT_LABEL_SELECTOR>",
    "labelAttribute": "<REVIEWED_SUBMIT_LABEL_ATTRIBUTE>",
    "allowedLabels": ["<REVIEWED_SUBMIT_LABEL>"]
  },
  "postSubmitPredicates": [
    { "key": "order-reference-visible", "selector": "<REVIEWED_ORDER_REFERENCE_SELECTOR>" },
    { "key": "payment-visible", "selector": "<REVIEWED_PAYMENT_SELECTOR>" }
  ]
}
```

`submitReadiness.selector` 必须与 `forbiddenActionSelectors` 中同一条已审查 selector 完全相同；
`finalOfficialOrigin` 与 `selection.allowedOrigins` 只能是无路径/查询的官方 HTTPS origin。`adjacencySelector`
若不要求连座可省略；数量必须二选一使用 `quantity.select` 或 `quantity.option`。占位符会被严格
校验拒绝，且绝不能为了让命令通过而放宽校验。可选的 `labelSelector`/`clickSelector`/`labelAttribute`
只有在 option 自身确实提供等价证据时才可省略；禁止用 `*`、`body`、整页文本或宽泛祖先 selector
替代唯一控件证据。

`damai-fast-path-contract.json` 必须是版本化 `FastPathContract`（当前 `version=1`），且只使用
已在本次官方页面核对过的、能唯一定位且可见的 CSS 选择器。至少覆盖：

1. 活动标题、活动 ID 及其属性来源；
2. 场次、票档、数量、观演人选项的 label/selected marker/click target 和 summary；
3. 票档可见价格与整数分属性、唯一订单总价与整数分属性、连座证据（若启用）；
4. CAPTCHA、登录失效、售罄、官方队列阻断选择器；
5. 所有不可逆控件的 `forbiddenActionSelectors`，以及仅用于观察、绝不点击的唯一提交控件
   `submitReadiness`；
6. 至少一个订单号证据和一个待支付证据 `postSubmitPredicates`。零提交演练只能校验这两项的
   contract schema 和 selector 语法，不会、也不能制造真实订单页来证明它们可见或唯一。

仓库没有任意 DOM/HTML 导出器，也没有自动 selector 猜测器。Mac agent 可在官方页面使用浏览器
DevTools 或受控的只读 Playwright 查询逐项核对 `count/visible/label/selected/price`，但只能把
固定 selector、布尔/计数证据和 digest 回传；不得保存或上传 HTML、截图、整页文本或个人数据。
先完成只读校准，再写入 contract；不能用 legacy `--rehearsal` 的一次通过替代 contract 校准。

## 三次同一 contract 的无提交演练

若尚未建立 live 专用登录会话，先运行以下人工登录入口；agent 只打开可见浏览器：

```bash
npm run build
npm run start:runner -- --login-only \
  --platform damai --url https://www.damai.cn/
```

用户完成登录并确认没有未知订单/支付标签后，关闭 TicketAgent 浏览器或按 `Ctrl-C`。然后在同一
Mac、同一 live profile、同一私有计划和同一 contract 上连续执行三轮。每轮必须从干净的 runner
生命周期开始；不要删除、复制、迁移或手工清理 profile/lock：

```bash
set -e
cd /Users/jakefan/ticket-agent
umask 077
report_dir="$(mktemp -d /private/tmp/ticket-agent-contract-rehearsal.XXXXXX)"
chmod 700 "$report_dir"
npm run build
for run in 1 2 3; do
  env -u TICKET_AGENT_TOKEN -u TICKET_AGENT_CAPABILITY_KEY \
    npm run start:runner -- --contract-rehearsal --confirm-rehearsal \
      --plan /absolute/path/damai-contract-rehearsal-plan.json \
      --contract /absolute/path/damai-fast-path-contract.json \
      --url '必须与计划 officialUrl 完全相同的官方 HTTPS URL' \
      > "$report_dir/run-${run}.json"
done
```

第一轮若出现 `PAGE_CHANGED`、`PAGE_TOPOLOGY_INVALID:*`、`RESTORED_PAGE_REVIEW_REQUIRED`、
`BLOCKING_STATE_VISIBLE`、selector/证据歧义、页面重定向、验证码或登录失效，立即停止，不运行后续
轮次；保留错误类别而不是重试或修改 selector 猜测。三轮之间若出现残留 lock，只做只读诊断并停止，
不得自动删除 lock/profile。

每轮报告是固定脱敏 schema：`mode`、`platform`、`origin`/`originHost`、
`eventIdentityMatch`/`eventTitleMatch`/`eventIdMatch`、`counts`、`attendeeCount`/`attendeeFingerprint`、
`selectionReady`、`documentStable`、`adjacentVerified`、`price`、`readiness`、
`reversibleActionCount`、`fakeClickCount`、`zeroSubmit`、
`postSubmitEvidence`、`outcome`、`reason` 和 `digest`；CLI 以退出码 0/1 表示成功/阻断。不得回传
标题、场次/票档/观演人 label、URL path/query、HTML、Cookie 或 profile 路径。成功演练应为
`outcome=REVIEW_REQUIRED`、`reason=NO_SUBMIT_REHEARSAL_COMPLETE`、`zeroSubmit=true`、
`fakeClickCount=0`、`selectionReady=true`、`documentStable=true`、`readiness.state=READY`、
`postSubmitEvidence=NOT_OBSERVED`；要求连座时 `adjacentVerified` 也必须为 `true`。可逆选择动作计数
大于零并不等于提交。三轮 contract `digest` 必须一致，活动/票档/数量/观演人/总价证据和唯一 submit
readiness 均一致且不超预算。
`postSubmitPredicates` 的真实订单号/待支付可见性仍是后续 blocker，不能写成已验收。

在 README 固定报告中的三条 `contract-rehearsal` 记录里回传下面的脱敏摘要，不粘贴 raw JSON；布尔值、
计数、fingerprint 和价格必须来自对应轮次，不能把第一轮结果复制到后两轮：

```text
contract-rehearsal run 1: exit=<0|1>; outcome=<...>; reason=<...>; digest=<sha256>; eventIdentityMatch=<true|false>; counts=<eventTitle/eventId/sessionOptions/tierOptions/quantityOptions/attendeeOptions/total/submit>; attendee=<count/fingerprint>; selectionReady=<true|false>; documentStable=<true|false>; adjacentVerified=<true|false>; price=<observedTotalFen/tierUnitPriceFen/maxTotalFen/withinLimit>; readiness=<state/controlCount/enabled/labelAccepted>; reversibleActionCount=<整数>; zeroSubmit=<true|false>; fakeClickCount=<整数>; postSubmitEvidence=<NOT_OBSERVED>
contract-rehearsal run 2: <与 run 1 相同字段，全部取本轮结果；digest 必须与 run 1 完全一致>
contract-rehearsal run 3: <与 run 1 相同字段，全部取本轮结果；digest 必须与 run 1/2 完全一致>
```

成功时三轮 `exit=0`、`outcome=REVIEW_REQUIRED`、`reason=NO_SUBMIT_REHEARSAL_COMPLETE`，并满足上面的
全部成功字段；任一轮不满足就原样报告并停止，不运行或补写后续轮次。

## 本阶段的硬停止门

- 绝不执行 `--live`、`--confirm-live`、`--controller-url`、`--run-id`，也不启动 controller；
- 不修改 `DamaiAdapter.liveReady`、`fastPathReady` 或任何 readiness 开关；
- 不把私有 plan/contract、raw JSON、Keychain 数据或页面 HTML 加入 Git；
- 点击结果未知、已有 `HELD` lock 或 capability 已领取时，不自动重跑；先人工核对官方订单；
- 三轮 contract rehearsal 只证明当前页面 contract 可复核且无提交，不能证明库存、队列、网络延迟或
  购票成功率，也不能单独解除 live readiness。

完成后按 README 的固定报告模板回传三轮 `contract-rehearsal` 结果、profile `0700`/lock 状态、
秘密卫生和剩余 blocker；等待用户另行明确的 readiness 审核指令。
