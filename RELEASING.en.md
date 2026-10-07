# Dual-Platform Tag Release

[简体中文](RELEASING.md) | [English](RELEASING.en.md)

Releases are coordinated by the parent repository `AliceJump/ok-script-toolkit`. Regular commits do not publish. A manual `Prepare Release` run synchronizes both repositories, updates both `main` branches directly, waits for their CI runs, and then pushes the version tag. The actual build and Marketplace publishing still start only from the first push of a matching version tag:

```text
vMAJOR.MINOR.PATCH
```

## One-time Configuration

All Secrets are added to the parent repo:

**Settings → Secrets and variables → Actions → New repository secret**

### One-click Release Bot

The `Prepare Release` workflow needs a GitHub App installed on both the parent repository and the JetBrains sub-repository. The same release bot used by other repositories can be reused.

Configure in the parent repository:

- Actions Variable: `RELEASE_APP_ID`
- Actions Secret: `RELEASE_APP_PRIVATE_KEY`

The GitHub App needs at least **Contents: Read and write** on both repositories and must be able to read Actions run status so the orchestrator can wait for CI after direct `main` pushes. Install it on:

- `AliceJump/ok-script-toolkit`
- `AliceJump/ok-script-toolkit-jetbrains`

Both repositories now allow normal fast-forward pushes to `main`; their rulesets only prevent deletion and non-fast-forward updates. Release PRs and ruleset bypasses are therefore no longer needed. The workflow uses the App token to push the JetBrains version commit directly to `main`, waits for that repository's `CI`, then pushes the parent version/gitlink commit to `main`, waits for parent `CI`, and only then pushes the parent version tag. The App-authenticated tag push triggers the existing `release.yml` workflow normally.

### Visual Studio Marketplace

It is recommended to configure **Trusted Publishing/OIDC** for Visual Studio Marketplace, avoiding long-lived Secrets:

1. Go to the Visual Studio Marketplace Publisher/extension management page.
2. Add a Trusted Publishing policy for `AliceJump.ok-script-toolkit`.
3. Fill in GitHub repo as `AliceJump/ok-script-toolkit`, workflow as `release.yml`, and environment as required by the Marketplace page (or leave empty).
4. Add `VSCE_USE_OIDC=true` in the parent repo under **Settings → Secrets and variables → Actions → Variables**.
5. The tag workflow already has `id-token: write` granted; when `VSCE_PAT` is not configured and this variable is `true`, it executes `vsce publish --oidc`.

If continuing with PAT for now, add Secret: `VSCE_PAT`

1. Open the Azure DevOps Personal Access Tokens page.
2. Create a new Token, selecting **All accessible organizations** for Organization.
3. Select **Custom defined**, expand all permissions, and check only **Marketplace → Manage**.
4. Copy the Token immediately after creation and save as `VSCE_PAT`.
5. Ensure the account that created the Token is a member of Visual Studio Marketplace Publisher `AliceJump`.

The repo already has this Secret configured as a fallback before OIDC setup is complete. Microsoft has announced global PATs will retire on 2026-12-01; migration to Trusted Publishing/OIDC should be done as soon as possible.

### JetBrains Marketplace First Listing

The first time requires manual plugin creation:

1. Log in to https://plugins.jetbrains.com/author/me.
2. Select **Add new plugin**.
3. Build the ZIP locally: `cd jetbrains && ./gradlew buildPlugin`.
4. Upload `build/distributions/ok-script-toolkit-jetbrains-<version>.zip`.
5. Confirm the Plugin XML ID is `com.alicejump.okscripttoolkit`, complete license, source code, issue tracker info, and submit for review.

After the first successful creation, the tag workflow can upload subsequent versions via API.

### JetBrains Release Token

Secret: `JETBRAINS_TOKEN`

1. Open https://plugins.jetbrains.com/author/me/tokens.
2. Select **Generate Token** and enter a name.
3. Copy the permanent Token immediately (shown only once).
4. Save it as parent repo Secret `JETBRAINS_TOKEN`.

### JetBrains Signing Keys

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

GitHub Secrets support multi-line text; you can paste PEM/CRT full text directly, or Base64-encode it to a single line first. Never commit private keys, certificates, or passwords. Generate new certificates and update corresponding Secrets before expiration.

## Each Release

There is one recommended entry point:

1. Open the parent repository and choose **Actions → Prepare Release → Run workflow**.
2. Normally **change nothing and click Run workflow**. If the parent, child, and gitlink are already synchronized at the current version but its tag is missing, the workflow finishes that prepared release first. If the current version is already tagged, it applies the selected `bump` (default: `minor`).
3. Choose `patch`, `minor`, or `major` only when you want a specific bump. Use an explicit `version=MAJOR.MINOR.PATCH` to resume an unusual partially prepared state.
4. An explicit `version` equal to the current version remains supported as a recovery mode: it verifies parent/child versions plus the gitlink and creates the missing tag.

One button performs the full orchestration:

1. Read `main` from the parent and JetBrains repositories and resolve the target version.
2. Reuse `sync-version.js` to update `package.json`, `package-lock.json`, `jetbrains/gradle.properties`, and all four README badges.
3. If the child needs a version change, create `chore(release): prepare vX.Y.Z` in the JetBrains repository, fast-forward it directly to `main`, wait for child `CI`, and confirm `main` did not move while waiting.
4. Update the parent gitlink and version files, create the matching release commit, fast-forward it directly to parent `main`, wait for parent `CI`, and confirm `main` still points at that release commit.
5. Run `verify:version` again, then create and push an annotated `vX.Y.Z` tag on the final parent `main`.
6. The App-authenticated tag push starts the existing `release.yml`. `Prepare Release` locates that downstream run and waits for it, so the one-click workflow's final result reflects build, GitHub Release, and Marketplace publishing.

`release.sh` / `release.ps1` are retained as local/manual-flow and troubleshooting references. Their direct-push behavior is now compatible with the repository rules, but **`Prepare Release` remains the production release entry point** because it additionally handles cross-repository version synchronization, the gitlink, CI waiting, and downstream publishing state.

If orchestration fails after the child was pushed but before the parent/tag step, fix the cause and rerun **Prepare Release** with the same explicit `version`. The orchestrator accepts a JetBrains `main` that has already reached the target and continues from there.

If either repository's `main` advances while the orchestrator is waiting for CI, the workflow aborts instead of force-pushing or overwriting newer commits. Rerun from the new `main` state.

Tag release proceeds as:

1. Check out the parent repo and pinned JetBrains submodule commit.
2. Validate all seven version locations (`package.json`, `package-lock.json`, `jetbrains/gradle.properties`, and all four README badges) match the tag exactly.
3. Test and build VSIX.
4. Test, validate, build, and sign the JetBrains ZIP using the Secrets.
5. Create a GitHub Release with both installers attached.
6. Publish to Visual Studio Marketplace when `VSCE_PAT` or OIDC is configured.
7. Publish to JetBrains Marketplace when the complete JetBrains Token and signing Secrets are present.

## Failure Handling

- Do not move or force-push a tag that has already been pushed.
- When a tag build fails, fix the code, bump the patch version (for example `0.6.0` → `0.6.1`), and push a new tag.
- Tags and GitHub Releases are not reusable; both Marketplaces also reject duplicate versions.
- If only Marketplace Secrets are missing, the GitHub Release is still created with both offline installers available.
- If a direct `main` push or CI wait fails, do not force-push. Fix the cause and rerun `Prepare Release` from the latest `main`.
