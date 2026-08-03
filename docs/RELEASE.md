# v0.1.0 冻结与发布记录

## 冻结定义

`v0.1.0` 是安全边界和当前实现的公开基线。冻结包含代码、测试、README 和运行手册；
后续修复应以新的提交和版本发布，不在用户 Mac 上静默改写 readiness。

冻结时必须保持：

- `liveReady=false`；
- `fastPathReady=false`；
- 大麦真实 selector/确认页 contract 未审核前不运行 `--live`；
- 猫眼适配器继续 fail-closed；
- 不提交私有 plan、contract、Chrome profile、Cookie、Keychain 或 benchmark 原始 JSON。

## 发布验收

维护者在发布提交上运行并记录：

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
git diff --check
```

2026-08-03 发布候选验收：`npm run check` 通过，单测 `288/288` 通过，mock smoke
`7/7` 通过，`npm audit` 为 0 个已知漏洞；Git 历史和发布内容的常见秘密模式扫描未发现
凭据、profile、Cookie、数据库或身份数据。GitHub Actions 会在公开提交上重复同一组构建、
类型检查、单测和 mock smoke。

真实活动、验证码、登录、人脸验证、支付、legacy rehearsal、contract rehearsal 和 `--live`
不属于公开 CI，也不应在发布机上运行。Mac 端若要继续校准，先阅读
[`docs/HANDOFF.md`](HANDOFF.md) 和 [`docs/CONTRACT_REHEARSAL.md`](CONTRACT_REHEARSAL.md)，
并把私有文件留在仓库外。

## 回滚

如果公开发布后的元数据或文档有问题，先在 GitHub 上撤回标签/发布说明，再回到上一个已审计
提交；不要用 `git reset --hard` 覆盖用户 Mac 上的未提交文件。功能性 readiness 变更必须
单独评审、测试并发布新的版本。
