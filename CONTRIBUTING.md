# Contributing

感谢参与。这个仓库的首要目标是可审计、可回滚的本地辅助工具，而不是绕过票务平台的
风控或验证码。任何贡献都必须保持这一边界。

## 开始之前

1. 使用 Node.js 22.13 或更高版本。
2. 安装依赖并运行安全的本地检查：

   ```bash
   npm ci --ignore-scripts
   npm run check
   npm test
   npm run smoke
   ```

3. 不要在仓库、issue、日志或测试输出中放入 Cookie、账号密码、身份证信息、短信码、
   Keychain 内容、支付信息、真实 Chrome profile 或私有活动 contract。

## 代码边界

- 只使用官方网页的可见控件；不得加入私有 API 逆向、验证码/人脸验证破解、代理池、
  多账号并发、设备指纹伪造或平台限购绕过。
- `liveReady` 和 `fastPathReady` 在当前冻结版本必须保持 `false`。不要提交自动开启
  readiness、自动支付或无人值守提交的改动。
- 登录、短信/人脸验证、验证码和支付由用户本人完成；未知页面、价格变化、拓扑变化和
  提交结果不确定时必须 fail-closed。
- 新适配器应复用安全接口，并为不确定的页面状态提供明确的阻断测试；不能复制大麦
  selector 到猫眼。

## 提交变更

- 一个 pull request 只解决一个清晰的问题，并说明安全影响和回滚方式。
- 代码、文档或依赖变化都要更新相应测试；公开文档中的示例必须使用占位符。
- 提交前确认 `git diff --check`、`npm run check`、`npm test` 和 `npm run smoke` 通过，
  且 `git status --short` 中没有个人文件。
- 不要运行 `--live`、真实购票或上传 benchmark 原始 JSON 来“证明”变更。

## Pull request 清单

- [ ] 没有秘密、个人身份数据、Cookie 或真实活动页面数据。
- [ ] 保持 `liveReady=false`、`fastPathReady=false`（除非维护者另行发布明确的安全评审）。
- [ ] 已补充回归测试和文档。
- [ ] 已在描述中列出验证命令、已知限制和回滚方法。
