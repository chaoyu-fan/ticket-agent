# macOS 落地流程

## 1. 安装与预检

安装 Node.js 22.13+ 和 Google Chrome，将项目复制到 Mac 后执行：

```bash
npm ci
bash scripts/setup-macos.sh
npm run check
npm test
```

不要把日常 Chrome 的目录、其父目录或 `Default` profile 配给执行器；live 与 sandbox profile 也不能相同或互为父子目录。首次使用 live 专用 profile 时，账号登录、实名观演人维护和安全验证都由用户在可见浏览器中完成。

## 2. 当前无活动链接时

执行默认计划的只读检查：

```bash
npm run build
npm run start:runner -- --dry-run --plan examples/default-damai-plan.json
```

预期结果是 `REVIEW_REQUIRED`，且没有浏览器、网络请求或点击。

## 3. 初始化 live 专用登录会话

可以在没有活动链接时先打开大麦首页，使用 live 专用 profile 手动完成登录和账号安全验证：

```bash
npm run build
npm run start:runner -- --login-only \
  --platform damai \
  --url https://www.damai.cn/
```

`login-only` 只打开可见浏览器，不读取购票计划，不选择票档，也不提交订单。完成登录后关闭浏览器或在终端按 `Ctrl-C`；会话只保存在 Mac 的 live 专用 profile。该模式不代表大麦适配器已经达到 `liveReady`，猫眼目前也不支持此模式。不要把 `--plan`、`--controller-url`、`--run-id` 或 `--confirm-live` 与它组合。

## 4. 获得大麦官方链接后

1. 把官方 HTTPS 活动链接、准确活动标题/ID 和开售时间写入计划。
2. 先用 `dry-run` 做只读页面分析，记录实际可见的场次、票档、总价和页面状态；不提供账号密码、Cookie、身份证或支付信息。
3. 根据真实页面更新并审核大麦 selector，完成页面改版、验证码、重定向和价格歧义测试。
4. 用专用 profile 人工登录，演练到订单确认页，核对活动、场次、票档、数量、观演人和总价。
5. 设置明确的 `maxTotalFen`；只有全量回归通过后才允许将大麦 `liveReady` 改为 `true`。

## 5. 真实执行时的强制条件

- `--live` 与 `--confirm-live` 同时出现；
- 使用 `--controller-url http://127.0.0.1:4317` 和控制器生成的 `--run-id`；
- plan 来自控制器，不能用本地文件替换；
- 最终可见价格在授权前和授权后都与不可变快照逐分相同；
- 控制器已取得该活动的唯一购买锁；
- 点击后只有看到唯一订单号和待支付状态才进入 `PAY_REQUIRED`，支付仍由用户完成。

距离 `saleAt` 超过 10 分钟时，CLI 协调器保持运行，每 30 秒确认控制器 run 仍为 `SCHEDULED`，但不会打开 live Chrome profile；进入 10 分钟预热窗口后才打开可见页面，并保持页面到开售时间。若进入官方排队页，只在同一页面串行检查可见 DOM（默认每 2 秒一次），不刷新、不并发开页，也不绕过队列。Mac 和终端必须保持运行；预热前按 `Ctrl-C` 会保留可重新启动的 `SCHEDULED`，预热后中断则先尝试把 run 记为 `FAILED` 再关闭 profile。

若授权后页面或价格变化，执行器停止且购买锁保持，必须由用户检查官方订单历史后才能显式释放。
