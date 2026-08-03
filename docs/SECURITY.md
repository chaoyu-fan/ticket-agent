# 安全与上线门槛

本项目只允许个人账号通过官方网页的可见控件完成一次购买尝试。验证码、登录、短信和支付始终由用户本人处理；不实现私有接口逆向、验证码破解、代理池、多账号并发或设备指纹伪造。

## 必须保持的约束

1. **目标绑定**：初始链接必须匹配计划平台；导航、选择和提交前后都必须再次验证当前页面仍在允许的官方域名或本机 mock 边界内。
2. **活动绑定**：计划中的活动 ID/标题必须与可见页面一致。跨平台同一活动使用 `canonicalEventKey` 竞争同一购买锁。
3. **模式隔离**：`dry-run` 零点击；`mock` 只访问 loopback 且永不提交；legacy `rehearsal` 无
   controller/capability；`contract-rehearsal` 使用 live profile 和同一 selection/submit-readiness
   contract，但也没有 controller/capability，并在导航前安装不可逆 click/form shield；`live` 必须显式
   确认、适配器已人工审核并使用可见浏览器，而且 CLI 只能走 resident fast path，代码明确拒绝回退
   `LocalRunner`。
4. **价格不可变**：唯一可见订单总价在 `VERIFY_PRICE` 首次记录后不可覆盖；最终点击前必须再次读取并与快照完全相同，同时不超过总预算和票档单价上限。
5. **选择可证实**：场次、票档、数量、观演人及连座要求必须有明确选中态或订单摘要证据。缺失、歧义或页面改版时停止。
6. **一次性提交**：只有控制器在价格快照一致且成功取得活动购买锁后，才能授予一次提交许可；计划的
   带时区 `saleAt` 必须签入最早消费时间，墙钟和单调时钟都越过该门才可消费。最终不可逆操作必须
   使用审核过的可信浏览器输入，点击结果不等于成功；必须看到唯一订单/待支付证据。
7. **人工确认成功**：普通 runner 事件不能直接写入 `SUCCESS`。完成状态只能由用户核对官方订单后显式确认。
8. **启动页与单页拓扑**：自动运行初始存在多个 restored page 时不做选择性清理并 fail-closed。`dry-run`/`mock`
   可在任何目标导航和动作前替换 sandbox 中唯一的 restored page；`rehearsal`/`live` 只允许替换唯一严格的
   `about:blank`，`contract-rehearsal` 采用相同 live-profile 策略；非空或多个恢复页保持可见并要求人工
   复核。建立 canonical page 后不得创建替代页；contract rehearsal 的同一个 listener-first sticky
   guard 从官方导航前覆盖 shield、resident 和最终证据，live 的同一 guard 继续覆盖 capability 和 click
   全链路。此后 popup、新页、context 关闭或原页关闭即使恢复也不得继续。
9. **本地数据**：Chrome profile 留在用户 Mac，live 与 sandbox profile 分离、权限为 `0700` 且单实例运行。
   contract-rehearsal 私有 plan/contract 必须是仓库外普通文件且权限为 `0600`；plan 只含 opaque
   attendee refs，Keychain labels 仅在进程内解析并清零。SQLite 文件权限为 `0600`。

启动归一化只关闭允许模式下的一个页面实例，不会删除 profile 或主动清除登录数据，但会改变恢复标签列表。
解决 `RESTORED_PAGE_REVIEW_REQUIRED`、`SINGLE_PAGE_CONTEXT_REQUIRED` 或 browser-context-closed 错误时，
禁止删除整个 profile、复制登录态或擅自清理 lock。
Chrome 子进程环境会显式剔除 controller Bearer token 与 capability key；capability key 也必须在任何 Chrome
启动前从 runner 环境移除，并在人工 profile review 前清零其内存副本。

## 真实模式发布门槛

- `npm run check`、全量单测和全部 mock 场景通过；
- 大麦适配器针对用户提供的官方活动页完成只读 selector 审核；
- 订单确认页演练能够正确绑定活动、场次、票档、数量、观演人和总价；
- 重定向、价格变化、重复执行器、验证码、登录失效和未知提交结果测试全部 fail-closed；
- 用户显式配置最高总价，且不向项目提供密码、Cookie、身份证号或支付信息。

在满足以上条件前，`liveReady` 与 `fastPathReady` 必须保持 `false`，fast-path contract/digest 也不得
配置。

浏览器驻留 ACK、durable delivery grant、sticky purchase lock、runner-session 绑定、prepared ACK、
Mac ref→Keychain label→选中 DOM 闭环、同步一次消费、最终证据复核和点击后上报已经接成 live 专用
授权链路。grant 存在后通用 runner event 不得改写 run；prepared ACK 和 attempt 会在事务内再核对
`PREWARM` run、`RUNNING` plan、`HELD` lock 及完整绑定。首次 delivery envelope 不持久化且绝不重发；
ACK 失败零点击，页面拓扑违反会粘滞取消，点击异常不重试。导航前 sticky page-topology guard 已由
CLI 在首次官方导航前创建，并将同一实例传入 rehearsal/live lifecycle；合成回归覆盖新页、popup、原页
关闭、context 关闭和 listener 清理。当前剩余的上线硬门包括大麦真实页面 selector/evidence contract、
Mac 无提交确认页演练和 contract-driven 验收；guard 的代码测试通过、浏览器启动生命周期修复、默认
sandbox 连续两次 dry-run 或合成 Chrome 基准都不能据此开启 live。

`contract-rehearsal` 的成功结果固定为无提交人工复核：不可逆 click/form shield、同一主文档
`documentStable=true` 与 sticky topology guard 必须都有效，输出保持脱敏且 `zeroSubmit=true`。它只证明 selection 与唯一 submit readiness；
`postSubmitEvidence` 必须保持 `NOT_OBSERVED`，真实订单号/待支付证据仍是 blocker。完成三轮也不得自动
修改 `liveReady`、`fastPathReady` 或把私有 contract 写入 adapter。

Controller Bearer token 与 `TICKET_AGENT_CAPABILITY_KEY` 必须是两把不同的至少 32 字节 secret，且都
不得进入日志、SQLite、浏览器、计划或仓库。当前 capability 使用 HMAC：个人 Mac 与 controller 属于
同一信任域时可接受，但 runner 持有验证 key 理论上也具备签名能力；若未来拆分为不互信设备，应改用
controller 私钥签名、runner 公钥验证的非对称方案。

## Chrome profile 锁恢复

执行器遇到 `PROFILE_IN_USE` 时不会自动删除锁文件。先关闭 TicketAgent 启动的 Chrome 窗口和 runner，读取对应专用 profile 中的 `.ticket-agent.runner.lock`，再用其中的 PID 检查进程是否仍存在；只要 PID 存活、仍有 Chrome 使用该 profile，或无法确认文件是当前用户拥有的普通文件，就不得移除锁。

只有在确认 runner 已异常退出、专用 Chrome 已完全关闭、PID 不存在且锁文件不是符号链接后，才可由用户手动移除这个**确切文件**。live 与 sandbox 的锁必须分别核对，禁止清理整个 profile 目录；profile 内保存的登录会话也不应复制到服务器或提交到仓库。

## 异常中断与订单恢复

正常的 `SIGINT`/`SIGTERM` 会先尝试把活动 run 收口为 `FAILED`；但 `SIGKILL`、断电或控制器持续不可达无法保证落库，可能留下 active run 或 `HELD` 购买锁。此时不得直接重跑、删除数据库锁或清理 profile 锁，必须先在官方订单历史中核对是否已经生成订单。

只有用户确认没有订单、run 已显式进入 `FAILED`、没有任何订单号证据，并提供控制器记录的**完整精确 event key** 时，才允许调用 `reconcile-no-order` 释放 `HELD` 锁。`PURCHASED` 锁永不释放；项目不会因失败、超时或重启自动再次提交。
