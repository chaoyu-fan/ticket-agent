## 变更说明

<!-- 简述问题、方案和回滚方式。不要粘贴任何私有活动数据。 -->

## 验证

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `git diff --check`

## 安全确认

- [ ] 没有提交 Cookie、令牌、身份/支付信息、Keychain 内容、Chrome profile 或 raw benchmark。
- [ ] 未运行真实购票，且未把 `liveReady` / `fastPathReady` 改为 `true`。
- [ ] 公开示例使用占位符，未知页面和提交结果仍 fail-closed。
