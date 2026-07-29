# 大麦本地仿真站

这个站点只用于验证执行器的失败关闭行为。服务启动函数把地址固定为 `127.0.0.1`，页面没有外部资源，也不会请求真实票务平台。

构建后运行：

```bash
npm run build
npm run start:mock
```

默认入口为 `http://127.0.0.1:4173/`。也可以设置 `MOCK_PORT`，但不能改变监听主机。

在 Mac 的第二个终端运行执行器；它使用 sandbox profile，完成选择后停在 `REVIEW_REQUIRED`，无论计划配置如何都不会点击提交：

```bash
npm run start:runner -- --mock \
  --plan examples/default-damai-plan.json \
  --url http://127.0.0.1:4173/damai/normal
```

| 路径 | 预期状态 |
| --- | --- |
| `/damai/normal` | 完成标准选择并停在 `REVIEW_REQUIRED`，不点击提交 |
| `/damai/queue` | `OFFICIAL_QUEUE` |
| `/damai/sold-out` | `SOLD_OUT` |
| `/damai/captcha` | `CAPTCHA_REQUIRED` / 人工接管 |
| `/damai/login-expired` | `LOGIN_EXPIRED` |
| `/damai/price-limit` | 最低总价 128,000 分，模拟上限 50,000 分 |
| `/damai/page-changed` | 关键选择器缺失，应判定 `PAGE_CHANGED` |

价格超限场景使用带 50,000 分上限的专用计划：

```bash
npm run start:runner -- --mock \
  --plan examples/mock-price-limit-plan.json \
  --url http://127.0.0.1:4173/damai/price-limit
```

稳定页面契约使用 `data-testid`：`login-status`、`sale-status`、`session-option`、`tier-option`、`quantity`、`attendee-option`、`order-total` 和 `submit-order`。`page-changed` 场景刻意不提供这些购票选择器，执行器不应猜测点击。
