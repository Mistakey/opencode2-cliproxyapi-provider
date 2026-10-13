# Releasing / 发布流程

Maintainer procedure for `Mistakey/opencode2-cliproxyapi-provider` → npm
`opencode2-cliproxyapi-provider`. Users install an exact published version through
OpenCode; they do not need these steps.

## Before a tag

1. Update package version, lock metadata and `src/host.ts`'s `PLUGIN_VERSION`
   together; the package check asserts agreement. Keep the pinned host API
   dependencies unless deliberately testing a compatibility change.
2. Update **both** READMEs, changelog and support boundaries. Do not relabel mock
   coverage as real CPA acceptance. No screenshot is required; any future terminal
   screenshot must redact keys, private addresses, paths and conversation data.
3. Run locked install, typecheck, `bun test`, `bun run smoke:package` with the
   fixed real host and loopback mocks. Inspect the tarball's file list and exports.
4. Scan the **Git history being pushed**, the current tree and the npm artifact
   for secrets. Ignore rules do not remove already-committed history. Check private
   endpoints, personal filesystem paths, raw logs, `.env`/`.npmrc`, auth files,
   temporary sandboxes and dependencies as well as conventional token patterns.
   If a real secret is found, stop publication and rotate it through its owner;
   do not silently rewrite shared history or merely hide it in a later commit.
5. Check dependency advisories and license obligations. No `npm audit fix --force`
   or untested dependency upgrade just to obtain a green count.
6. Push reviewed main, observe actual GitHub CI, then create `v<package.version>`
   pointing to that commit. Never push all local development refs/worktrees.

## Publication gate

`.github/workflows/ci.yml` runs on pull requests/main pushes and has read-only
repository permission. It never publishes.

`.github/workflows/publish.yml` has **only `workflow_dispatch`**. Select an existing
exact version tag (not main), for example:

```sh
gh workflow run publish.yml --ref v0.1.1
```

The workflow checks that the tag matches the manifest, repeats the same Windows
verification, downloads the exact checked tarball, and publishes it using npm
OIDC with required provenance. Only the publish job receives `id-token: write`;
no stored npm publish token is used. A separate Release job receives
`contents: write` and no OIDC permission. The tarball is not rebuilt between
verification and publication.

Before publishing, the workflow reads the exact public npm version. Only a 404
means it may publish; a registry/auth/network failure stops it. An existing version
must have the same integrity and tarball bytes, with OIDC provenance, or the run
stops without overwriting anything. After a publish, bounded registry reads
reconcile even a lost CLI response without repeating the write.

The Release job rechecks public npm bytes, requires the existing tag to resolve
to the verified commit, and uses the version's bilingual changelog plus links to
both READMEs and verification/security boundaries. It creates a draft, attaches
the checked `.tgz` and `SHA256SUMS`, then publishes the Release. On retry, matching
notes/assets are preserved and missing assets are added; conflicting content
stops the run. Tags and existing assets are never moved or replaced.

If npm succeeded but a later step failed, rerun the original failed jobs or
manually dispatch **the same tag**. Full dispatch repeats CI and must reproduce
the same artifact. Do not bump a version just to finish its Release, and do not
switch to token publishing after OIDC failure.

### npm trusted publishing

A package owner configures npm's **Trusted Publisher** in the package settings:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | `Mistakey` |
| Repository | `opencode2-cliproxyapi-provider` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty (this workflow does not declare an environment) |

Use npm's direct-publish permission if the UI offers staged/direct choices.
The job uses npm >=11.5.1 and Node >=22.14; trusted publishing from a public repo
creates provenance automatically. Follow npm's current expiry/verification rules.
Do not disable 2FA or commit a token to work around an authentication failure.

**First-package bootstrap:** trusted publishing is configured in an existing
package's settings. If npm cannot configure the never-published name, the owner
must first publish the **verified tarball** through official npm browser login/2FA:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish .forge/local/package/opencode2-cliproxyapi-provider-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
```

A maintainer can perform the publish after the owner logs in, but browser/OTP
approval stays with the owner. Never ask them to paste a token or OTP into an
issue/chat. Record whether the first release used this manual bootstrap or OIDC;
a local bootstrap must **not** claim CI provenance. Configure OIDC for subsequent
versions instead of storing a long-lived CI token. Do not publish a dummy version
or republish an existing immutable version to test authentication.

## After publication

- Read npm's `dist.integrity`, download the public exact version and compare it
  with the verified tarball. Exercise that installed artifact with mock fixtures.
- Confirm the workflow's GitHub Release is public on the same tag, with both
  language links, the verified tarball and checksum attachments.
- Publication does **not** authorize updating an existing installation. Install
  into the user's **confirmed** OpenCode/config location only after a
  backup, with `opencode plugin add <name>@<exact-version>`. Check the resolved
  version and entries, preserving unrelated settings and credentials.
- Do not send a paid model request as an installation check. Loading a configured
  connection may itself perform directory GET/background refresh and models.dev
  reads; disclose that before touching the daily environment.
- If a bad immutable release escapes, publish a corrected version and document
  rollback/pinning; do not move its Git tag or pretend an artifact was replaced.

中文摘要：检查双语文档、许可、依赖、Git 历史及实际 npm 产物；PR/普通 push 不发布。精确 tag 手动触发 OIDC 发布，随后自动核验公开 registry 的 integrity、包字节及 provenance，并生成双语 Release 与 tgz/校验和附件。npm 已成功时可重试同一 tag：同内容继续收尾，冲突则停止，不覆盖版本、移动 tag 或替换附件。OIDC 与 Release 写权限分属不同作业，认证失败不退回 token。0.1.0 首发的人工引导不代表 CI provenance。发布不授权升级日常安装；安装固定新版本须另获用户同意，不追加收费模型测试。
