# 双端标签发布 / Dual-Platform Tag Release

发布由父仓库 `AliceJump/ok-script-toolkit` 统一协调。普通提交和手动运行不会发布；只有首次推送匹配版本的标签会运行 Release：

Releases are coordinated by the parent repo `AliceJump/ok-script-toolkit`. Regular commits and manual runs do not publish; only a first-time push of a matching version tag triggers a Release:

```text
vMAJOR.MINOR.PATCH
```

---

## 中文

### 一次性配置

所有 Secret 都添加到父仓库：

**Settings → Secrets and variables → Actions → New repository secret**

#### Visual Studio Marketplace

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

#### JetBrains Marketplace 首次上架

第一次必须手动创建插件：

1. 登录 https://plugins.jetbrains.com/author/me 。
2. 选择 **Add new plugin**。
3. 在本地构建 ZIP：`cd jetbrains && ./gradlew buildPlugin`。
4. 上传 `build/distributions/ok-script-toolkit-jetbrains-<version>.zip`。
5. 确认 Plugin XML ID 是 `com.alicejump.okscripttoolkit`，完成许可、源码、问题反馈等资料并提交审核。

第一次创建成功之后，标签工作流才能通过 API 上传后续版本。

#### JetBrains 发布 Token

Secret：`JETBRAINS_TOKEN`

1. 打开 https://plugins.jetbrains.com/author/me/tokens 。
2. 选择 **Generate Token**，输入名称。
3. 立即复制只显示一次的永久 Token。
4. 保存为父仓库 Secret `JETBRAINS_TOKEN`。

#### JetBrains 签名密钥

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

### 每次发布

例如发布 `0.6.0`：

```bash
# 1. 同步全部五处版本：package.json、package-lock.json、jetbrains/gradle.properties
#    以及两个 README 的 version 徽章（少提交任何一处，Release 的 validate 都会失败）
npm run version:sync -- 0.6.0

# 2. 验证
npm test
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
cd ..

# 3. 先提交子仓库版本变更
cd jetbrains
git add .
git commit -m "chore(release): prepare v0.6.0"
git push origin main
cd ..

# 4. 再提交父仓库版本、README 徽章和子模块指针
#    注意 README.md 必须一起提交：version:sync 会改它的徽章，
#    而 verify-version.js 会在标签流水线里校验它（2026-09 就漏提交过一次，导致 v1.6.0 校验失败）
npm run verify:version
git add package.json package-lock.json README.md jetbrains
git commit -m "chore(release): prepare v0.6.0"
git push origin main

# 5. 唯一发布动作：创建并推送新标签
git tag -a v0.6.0 -m "Release v0.6.0"
git push origin v0.6.0
```

标签发布会依次：

1. 检出父仓库和固定的 JetBrains 子模块提交。
2. 校验三处版本与标签完全一致。
3. 测试并构建 VSIX。
4. 测试、验证、构建并按 Secret 签名 JetBrains ZIP。
5. 创建一个 GitHub Release，附带两个安装包。
6. 有 `VSCE_PAT` 时发布 Visual Studio Marketplace。
7. 有完整 JetBrains Token 和签名 Secrets 时发布 JetBrains Marketplace。

### 失败处理

- 不要移动或强制覆盖已经推送的标签。
- 标签构建失败时，修复后提升补丁版本，例如从 `0.6.0` 改为 `0.6.1`，再推送新标签。
- 标签和 GitHub Release 都不可复用；两个 Marketplace 也拒绝重复版本。
- 如果只缺 Marketplace Secret，GitHub Release 仍会创建并提供两个离线安装包。

---

## English

### One-time Configuration

All Secrets are added to the parent repo:

**Settings → Secrets and variables → Actions → New repository secret**

#### Visual Studio Marketplace

It is recommended to configure **Trusted Publishing/OIDC** for Visual Studio Marketplace, avoiding long-lived Secrets:

1. Go to the Visual Studio Marketplace Publisher/extension management page.
2. Add a Trusted Publishing policy for `AliceJump.ok-script-toolkit`.
3. Fill in GitHub repo as `AliceJump/ok-script-toolkit`, workflow as `release.yml`, and environment as required by the Marketplace page (or leave empty).
4. Add `VSCE_USE_OIDC=true` in the parent repo under **Settings → Secrets and variables → Actions → Variables**.
5. The tag workflow already has `id-token: write` granted; when `VSCE_PAT` is not configured and this variable is `true`, it will execute `vsce publish --oidc`.

If continuing with PAT for now, add Secret: `VSCE_PAT`

1. Open the Azure DevOps Personal Access Tokens page.
2. Create a new Token, selecting **All accessible organizations** for Organization.
3. Select **Custom defined**, expand all permissions, and check only **Marketplace → Manage**.
4. Copy the Token immediately after creation and save as `VSCE_PAT`.
5. Ensure the account that created the Token is a member of Visual Studio Marketplace Publisher `AliceJump`.

The repo already has this Secret configured as a fallback before OIDC setup is complete. Microsoft has announced global PATs will retire on 2026-12-01; migration to Trusted Publishing/OIDC should be done as soon as possible.

#### JetBrains Marketplace First Listing

The first time requires manual plugin creation:

1. Log in to https://plugins.jetbrains.com/author/me.
2. Select **Add new plugin**.
3. Build the ZIP locally: `cd jetbrains && ./gradlew buildPlugin`.
4. Upload `build/distributions/ok-script-toolkit-jetbrains-<version>.zip`.
5. Confirm the Plugin XML ID is `com.alicejump.okscripttoolkit`, complete license, source code, issue tracker info, and submit for review.

After the first successful creation, the tag workflow can upload subsequent versions via API.

#### JetBrains Release Token

Secret: `JETBRAINS_TOKEN`

1. Open https://plugins.jetbrains.com/author/me/tokens.
2. Select **Generate Token** and enter a name.
3. Copy the permanent Token immediately (shown only once).
4. Save as parent repo Secret `JETBRAINS_TOKEN`.

#### JetBrains Signing Keys

Secrets:

- `JETBRAINS_PRIVATE_KEY`
- `JETBRAINS_PRIVATE_KEY_PASSWORD`
- `JETBRAINS_CERTIFICATE_CHAIN`

Generate using OpenSSL:

```bash
openssl genpkey -aes-256-cbc -algorithm RSA \
  -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
openssl rsa -in private_encrypted.pem -out private.pem
openssl req -key private.pem -new -x509 -days 365 -out chain.crt
```

- `JETBRAINS_PRIVATE_KEY`: Full text of `private.pem`.
- `JETBRAINS_PRIVATE_KEY_PASSWORD`: Password set in the first command and used in the second.
- `JETBRAINS_CERTIFICATE_CHAIN`: Full text of `chain.crt`.

GitHub Secrets support multi-line text; you can paste PEM/CRT full text directly, or Base64-encode to a single line first. Never commit private keys, certificates, or passwords. Generate new certificates and update corresponding Secrets before expiration.

### Each Release

For example, releasing `0.6.0`:

```bash
# 1. Sync all five version locations: package.json, package-lock.json, jetbrains/gradle.properties
#    and both README version badges (missing any one causes Release validation failure)
npm run version:sync -- 0.6.0

# 2. Verify
npm test
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
cd ..

# 3. Commit sub-repo version changes first
cd jetbrains
git add .
git commit -m "chore(release): prepare v0.6.0"
git push origin main
cd ..

# 4. Then commit parent repo version, README badge, and new submodule pointer
#    Note: README.md must be committed together — version:sync modifies its badge,
#    and verify-version.js checks it in the tag pipeline (a missing commit in 2026-09
#    caused v1.6.0 validation failure)
npm run verify:version
git add package.json package-lock.json README.md jetbrains
git commit -m "chore(release): prepare v0.6.0"
git push origin main

# 5. The only release action: create and push a new tag
git tag -a v0.6.0 -m "Release v0.6.0"
git push origin v0.6.0
```

Tag release proceeds as:

1. Check out the parent repo and pinned JetBrains submodule commit.
2. Validate all three versions match the tag exactly.
3. Test and build VSIX.
4. Test, validate, build, and sign the JetBrains ZIP using the Secrets.
5. Create a GitHub Release with both installers attached.
6. Publish to Visual Studio Marketplace if `VSCE_PAT` is present.
7. Publish to JetBrains Marketplace if complete JetBrains Token and signing Secrets are present.

### Failure Handling

- Do not move or force-push a tag that has already been pushed.
- When a tag build fails, fix the code, bump the patch version (e.g., `0.6.0` → `0.6.1`), and push a new tag.
- Tags and GitHub Releases are not reusable; both Marketplaces also reject duplicate versions.
- If only Marketplace Secrets are missing, the GitHub Release is still created with both offline installers available.