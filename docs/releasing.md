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
gh workflow run publish.yml --ref v0.1.0
```

The workflow checks that the tag matches the manifest, repeats the same Windows
verification, downloads the exact checked tarball, and publishes it using npm
OIDC. Only the publish job receives `id-token: write`; no stored npm publish token
is used. The tarball is not rebuilt between verification and publication.

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
- Create a GitHub Release on the same tag; attach the tarball and checksum if
  desired. Link to npm, both READMEs and the honest verification boundaries.
- Install into the user's **confirmed** OpenCode/config location only after a
  backup, with `opencode plugin add <name>@<exact-version>`. Check the resolved
  version and entries, preserving unrelated settings and credentials.
- Do not send a paid model request as an installation check. Loading a configured
  connection may itself perform directory GET/background refresh and models.dev
  reads; disclose that before touching the daily environment.
- If a bad immutable release escapes, publish a corrected version and document
  rollback/pinning; do not move its Git tag or pretend an artifact was replaced.

中文摘要：检查双语文档、许可、依赖、Git 历史及实际 npm 产物；PR/普通 push 不发布。发布工作流只能对精确 tag 手动触发，并优先使用 npm OIDC。首次包若须人工引导，使用官方登录/2FA 发布已验证 tarball，不能声称具备 CI provenance。发布后校验 registry 产物，再备份并安装用户已确认的固定版本；不追加收费模型测试。
