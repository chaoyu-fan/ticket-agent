# 大麦优先实施计划

## 用户默认策略

公开仓库只提供占位的大麦 selector 校准计划，不绑定任何真实活动。
仍采用保守默认值：一张票、所有可见票档中最低价优先、未设置最高总价时不自动提交订单。
用户选定正式购买目标并明确预算后，才在正式计划中设置 `maxTotalFen`、opaque
`attendeeRefs` 及其本机 Keychain 映射和 `autoSubmitOrder`。

## 里程碑

1. **已完成**：核心控制器、计划 CRUD、SQLite 审计、不可变价格快照、一次性提交批准和跨平台重复购买锁。
2. **已完成**：macOS 独立 Chrome 配置、手动登录边界以及 dry-run/mock/live 三种显式模式。
3. **仿真完成、真实 selector 待审核**：公开 fixture 使用占位活动 ID；
   队列、验证码、登录失效、售罄、重定向、价格变化和页面改版全部 fail-closed，
   但当前真实页尚未映射到严格 DOM 契约。
4. **调度仿真完成、contract-driven 无提交演练待执行**：远期开售保持 `SCHEDULED`，进入 10 分钟预热窗口后等待
   `saleAt`，官方队列仅同页串行轮询；Mac 需先完成真实 selector/evidence 的只读校准，再用同一版本化
   `FastPathContract` 连续三次运行 `--contract-rehearsal`。该模式没有 controller/capability/提交能力，
   `postSubmitEvidence` 固定为 `NOT_OBSERVED`。
5. **待完成**：真实订单号/待支付证据的确认页审核；若活动需要详情页到确认页的独立阶段，需先设计
   versioned staged contract；大麦 readiness 继续关闭。
6. **待完成**：猫眼独立适配器；复用安全接口，但不共享大麦选择器或账号会话。

## 为什么不把浏览器放在服务器

账号会话、实名观演人和设备网络更适合留在用户的 Mac 上。控制器也默认运行在 Mac loopback；当前服务器只保存开发工程，不安装浏览器镜像，也不触碰现有 OpenClaw/WeCode 服务。

## 开发和上线边界

- 不逆向私有 API，不破解验证码，不使用代理池或多账号并发。
- 页面出现验证、异常价格或未知结构时停止，不猜测点击。
- 真实购买成功率由库存和官方队列决定，验收指标是状态正确、预算不越界、无重复提交和可人工接管。
