# 双端标签发布

[简体中文](RELEASING.md) | [English](RELEASING.en.md)

发布由父仓库 `AliceJump/ok-script-toolkit` 统一协调。普通提交不会发布；手动运行 `Prepare Release` 会同步两仓版本、直接更新两个仓库的 `main`、等待对应 CI，然后推送版本标签。真正的构建与 Marketplace 发布仍只由首次推送匹配版本的标签触发：

```text
vMAJOR.MINOR.PATCH
```

---

## 一次性配置

所有 Secret 都添加到父仓库：

**Settings → Secrets and variables → Actions → New repository secret**

### 一键发版凭据

`Prepare Release` 不使用 GitHub App 或 release bot。它使用维护者自己的 GitHub PAT，以该账号身份直接更新父仓和 JetBrains 子仓的 `main`，并推送最终版本 tag。

父仓库添加一个 Actions Secret：

- `RELEASE_TOKEN`

推荐使用 fine-grained PAT，并只授权：

- `AliceJump/ok-script-toolkit`
- `AliceJump/ok-script-toolkit-jetbrains`

所需仓库权限：

- **Contents: Read and write**：提交并直接推送两个仓库的 `main` 与父仓版本 tag。
- **Actions: Read**：等待两个仓库直推后的 CI 结果。

两个仓库的 `main` 当前允许正常 fast-forward 直接推送，只保留防删除和防 force-push 规则，因此不需要 release PR，也不需要 ruleset bypass。release commit 的 Git author 会使用实际点击 `Run workflow` 的 GitHub 账号；认证和远端 push 则使用 `RELEASE_TOKEN` 对应的维护者账号。

必须使用 PAT 而不是工作流内置的 `GITHUB_TOKEN`，因为这里需要跨仓库写入 JetBrains 子仓，而且 PAT 推送最终 tag 后需要正常触发 `release.yml`。

### Visual Studio Marketplace

推荐配置 Visual Studio Marketplace 的 **Trusted Publishing/OIDC**，无需保存长期 Secret：

1. 进入 Visual Studio Marketplace 的 Publisher/扩展管理页面。
2. 为 `AliceJump.ok-script-toolkit` 添加 Trusted Publishing policy。
3. GitHub 仓库填写 `AliceJump/ok-script-toolkit`，工作流填写 `release.yml`，环境按 Marketplace 页面要求填写或留空。
4. 在父仓库 **Settings → Secrets and variables → Actions → Variables** 添加 `VSCE_USE_OIDC=true`。
5. 标签工作流已授予 `id-token: write`，未配置 `VSCE_PAT` 且该变量为 `true` 时会执行 `vsce publish --oidc`。

如暂时继续使用 PAT，则添加 Secret：`VSCE_PAT`

1. 打开 Azure DevOps 的 Personal Access Tokens 页面。
2. 新建 Token，Organization 选择 **All accessible organizations**。
3. 选择 **Custom defined**，展开所有权限，仅勾选 **Marketplace → Manage**。
4. 创建后立即复制 Token，保存为 `VSCE_PAT`。
5. 确保创建 Token 的账号是 Visual Studio Marketplace Publisher `AliceJump` 的成员。

目前仓库已经配置该 Secret，可作为 OIDC 配置完成前的回退。Microsoft 已宣布全局 PAT 将于 2026-12-01 退役，应尽快迁移到 Trusted Publishing/OIDC。

### JetBrains Marketplace 首次上架

第一次必须手动创建插件：

1. 登录 https://plugins.jetbrains.com/author/me 。
2. 选择 **Add new plugin**。
3. 在本地构建 ZIP：`cd jetbrains && ./gradlew buildPlugin`。
4. 上传 `build/distributions/ok-script-toolkit-jetbrains-<version>.zip`。
5. 确认 Plugin XML ID 是 `com.alicejump.okscripttoolkit`，完成许可、源码、问题反馈等资料并提交审核。

第一次创建成功之后，标签工作流才能通过 API 上传后续版本。

### JetBrains 发布 Token

Secret：`JETBRAINS_TOKEN`

1. 打开 https://plugins.jetbrains.com/author/me/tokens 。
2. 选择 **Generate Token**，输入名称。
3. 立即复制只显示一次的永久 Token。
4. 保存为父仓库 Secret `JETBRAINS_TOKEN`。

### JetBrains 签名密钥

Secrets：

- `JETBRAINS_PRIVATE_KEY`
- `JETBRAINS_PRIVATE_KEY_PASSWORD`
- `JETBRAINS_CERTIFICATE_CHAIN`

使用 OpenSSL 生成：

```bash
openssl genpkey -aes-256-cbc -algorithm RSA \
  -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -in private_encrypted.pem -out private.pem
openssl req -key private.pem -new -x509 -days 365 -out chain.crt
```

- `JETBRAINS_PRIVATE_KEY`：`private.pem` 的完整文本。
- `JETBRAINS_PRIVATE_KEY_PASSWORD`：第一条命令设置、第二条命令使用的密码。
- `JETBRAINS_CERTIFICATE_CHAIN`：`chain.crt` 的完整文本。

GitHub Secret 支持多行文本，可直接粘贴 PEM/CRT 全文；也可先 Base64 编码为单行。不要提交私钥、证书或密码。证书到期前需生成新证书并更新对应 Secrets。

## 每次发布

推荐入口只有一个：

1. 打开父仓库 **Actions → Prepare Release → Run workflow**。
2. 平时**什么都不用改，直接点 Run workflow**：如果当前版本的父/子仓与 gitlink 已同步但 tag 缺失，会先补当前版本 tag；如果当前版本已经有 tag，才按 `bump` 递增，默认 `minor`。
3. 需要指定下一版时可把 `bump` 改成 `patch` / `minor` / `major`；需要恢复特殊中间状态时，也可以显式填写 `version=MAJOR.MINOR.PATCH`。
4. 显式 `version` 等于当前版本仍然受支持，作为恢复模式会校验父/子仓版本与 gitlink 后补缺失 tag。

一次按钮会自动完成：

1. 读取父仓 `main` 和 JetBrains 子仓 `main`，计算目标版本。
2. 调用现有 `sync-version.js` 同步 `package.json`、`package-lock.json`、`jetbrains/gradle.properties` 与四份 README 徽章。
3. 如子仓需要改版本，在 JetBrains 子仓提交 `chore(release): prepare vX.Y.Z`，直接 fast-forward 推送到 `main`，等待子仓 `CI` 成功，并确认 `main` 没有在等待期间被其他提交推进。
4. 更新父仓 gitlink 和版本文件，提交同名 release commit，直接 fast-forward 推送到父仓 `main`，等待父仓 `CI` 成功，并再次确认 `main` 仍指向本次 release commit。
5. 再次运行 `verify:version`，然后给父仓最终 `main` 创建并推送 `vX.Y.Z` annotated tag。
6. `RELEASE_TOKEN` 推送 tag 后，现有 `release.yml` 自动开始；`Prepare Release` 会找到这次下游运行并等待它结束，所以按钮这一条 workflow 的最终状态会直接反映构建、GitHub Release 和 Marketplace 发布是否成功。

`release.sh` / `release.ps1` 仍保留作本地手动流程和故障排查参考。它们的直接推送方式现在与仓库规则兼容，但**正式发布入口仍是 `Prepare Release`**，因为自动流程会额外处理双仓版本、gitlink、CI 等待与下游发布状态。

如果编排在“子仓已推送、父仓尚未推送”之类的中间状态失败，修复原因后重新运行 **Prepare Release**，并在 `version` 中填同一个目标版本；脚本允许 JetBrains `main` 已经先到达目标版本，并会继续完成父仓和 tag。

如果任一仓库的 `main` 在编排等待 CI 期间被其他提交推进，流程会主动中止，不会 force-push 或覆盖新提交。此时从新的 `main` 状态重新运行即可。

标签发布会依次：

1. 检出父仓库和固定的 JetBrains 子模块提交。
2. 校验七处版本（`package.json`、`package-lock.json`、`jetbrains/gradle.properties` 与四个 README 的徽章）与标签完全一致。
3. 测试并构建 VSIX。
4. 测试、验证、构建并按 Secret 签名 JetBrains ZIP。
5. 创建一个 GitHub Release，附带两个安装包。
6. 有 `VSCE_PAT` 或 OIDC 配置时发布 Visual Studio Marketplace。
7. 有完整 JetBrains Token 和签名 Secrets 时发布 JetBrains Marketplace。

## 失败处理

- 不要移动或强制覆盖已经推送的标签。
- 标签构建失败时，修复后提升补丁版本，例如从 `0.6.0` 改为 `0.6.1`，再推送新标签。
- 标签和 GitHub Release 都不可复用；两个 Marketplace 也拒绝重复版本。
- 如果只缺 Marketplace Secret，GitHub Release 仍会创建并提供两个离线安装包。
- 直推 `main` 或等待 CI 失败时，不要 force-push；修复原因后从最新 `main` 重新运行 `Prepare Release`。
