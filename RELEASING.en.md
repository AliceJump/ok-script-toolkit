# Dual-Platform Tag Release

[简体中文](RELEASING.md) | [English](RELEASING.en.md)

Releases are coordinated by the parent repository `AliceJump/ok-script-toolkit`. Regular commits and manual runs do not publish; only the first push of a matching version tag triggers a Release:

```text
vMAJOR.MINOR.PATCH
```

## One-time Configuration

All Secrets are added to the parent repo:

**Settings → Secrets and variables → Actions → New repository secret**

### Visual Studio Marketplace

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
4. Save as parent repo Secret `JETBRAINS_TOKEN`.

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

GitHub Secrets support multi-line text; you can paste PEM/CRT full text directly, or Base64-encode to a single line first. Never commit private keys, certificates, or passwords. Generate new certificates and update corresponding Secrets before expiration.

## Each Release

> **Prefer the one-shot script**: `npm run release -- --minor` (or `sh scripts/release.sh --minor`;
> Windows can use `scripts/release.ps1`). It performs every step below automatically — syncing the
> seven version locations, verifying, committing/pushing sub-repo then parent, and finally tagging.
> Add `--dry-run` to preview first. The script only runs on the `main` branch
> (required for both the parent repo and the jetbrains submodule) and refuses
> otherwise — the release commit lands on whatever branch it runs from (hit on v1.12.0).
> If releasing manually, follow the order below exactly and
> **do not skip any step**.

On Windows, `scripts/release.ps1` first stashes uncommitted changes separately in the
parent and JetBrains repositories, including untracked files but excluding ignored files.
The release uses committed code; automatic version increments use the version in `HEAD`.
It attempts to restore this run's stashes and the original staging state afterward,
without touching existing stashes. Conflicting stashes are retained and their commit IDs
are printed. Uncommitted version changes left by a failed release are stashed separately;
successful commits or pushes are not rolled back. PowerShell uses `-DryRun` to preview
without stashing or releasing. The Shell script still requires clean workspaces.

Run `node scripts/test_release.js` to verify the PowerShell release flow. It requires
`git`, `node`, and `pwsh`, and uses temporary repositories and local remotes only.

For example, releasing `0.6.0`:

```bash
# 1. Sync all seven version locations: package.json, package-lock.json, jetbrains/gradle.properties
#    and all four README version badges (missing any one causes Release validation failure)
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
2. Validate all seven version locations (`package.json`, `package-lock.json`, `jetbrains/gradle.properties`, and all four README badges) match the tag exactly.
3. Test and build VSIX.
4. Test, validate, build, and sign the JetBrains ZIP using the Secrets.
5. Create a GitHub Release with both installers attached.
6. Publish to Visual Studio Marketplace if `VSCE_PAT` is present.
7. Publish to JetBrains Marketplace if complete JetBrains Token and signing Secrets are present.

## Failure Handling

- Do not move or force-push a tag that has already been pushed.
- When a tag build fails, fix the code, bump the patch version (e.g., `0.6.0` → `0.6.1`), and push a new tag.
- Tags and GitHub Releases are not reusable; both Marketplaces also reject duplicate versions.
- If only Marketplace Secrets are missing, the GitHub Release is still created with both offline installers available.
