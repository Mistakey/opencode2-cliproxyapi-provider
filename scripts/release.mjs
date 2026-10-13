#!/usr/bin/env node
// Publication consumes the CI artifact unchanged. Only external reads are retried;
// uncertain writes are reconciled by reading the immutable version/asset again.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REGISTRY = "https://registry.npmjs.org"
const REPOSITORY = "Mistakey/opencode2-cliproxyapi-provider"
const hash = (bytes, algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function loadArtifact(directory, manifest, ref) {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "Only stable version tags are published")
  assert.equal(manifest.name, "opencode2-cliproxyapi-provider")
  assert.equal(ref, `refs/tags/v${manifest.version}`, "Tag must equal v<package.version>")
  const filename = `${manifest.name}-${manifest.version}.tgz`
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tgz")), [filename], "Expected one exact-version CI tarball")
  const bytes = readFileSync(join(directory, filename))
  const sha256 = hash(bytes, "sha256")
  const checksum = readFileSync(join(directory, "SHA256SUMS"))
  assert.equal(checksum.toString().trim(), `${sha256}  ${filename}`, "Artifact checksum/name mismatch")
  const packed = JSON.parse(readFileSync(join(directory, "pack.json"), "utf8"))
  const integrity = `sha512-${hash(bytes, "sha512", "base64")}`
  assert.equal(packed.name, manifest.name)
  assert.equal(packed.version, manifest.version)
  assert.equal(packed.filename, filename)
  assert.equal(packed.integrity, integrity, "Pack metadata integrity mismatch")
  return { name: manifest.name, version: manifest.version, filename, bytes, checksum, sha256, integrity, path: resolve(directory, filename) }
}

async function request(fetchImpl, url, options = {}) {
  return fetchImpl(url, { signal: AbortSignal.timeout(60_000), ...options })
}

export async function readRegistry(artifact, fetchImpl = fetch) {
  const response = await request(fetchImpl, `${REGISTRY}/${artifact.name}/${artifact.version}`, { cache: "no-store", redirect: "error" })
  if (response.status === 404) return undefined
  assert.equal(response.status, 200, `Registry metadata read failed (${response.status}); absence is only HTTP 404`)
  return response.json()
}

export async function verifyRegistry(artifact, metadata, fetchImpl = fetch) {
  assert.equal(metadata.name, artifact.name, "Registry package mismatch")
  assert.equal(metadata.version, artifact.version, "Registry version mismatch")
  assert.equal(metadata.dist?.integrity, artifact.integrity, "Published version conflicts with verified artifact; never overwrite it")
  const url = new URL(metadata.dist.tarball)
  assert.equal(url.origin, REGISTRY, "Tarball must come from the public npm registry")
  const response = await request(fetchImpl, url, { redirect: "error" })
  assert.equal(response.status, 200, "Registry tarball download failed")
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), artifact.bytes, "Public tarball differs from verified artifact")
  assert.equal(metadata.dist?.attestations?.provenance?.predicateType, "https://slsa.dev/provenance/v1", "OIDC provenance is required; do not fall back to a token publish")
  console.log(`PASS public npm ${artifact.name}@${artifact.version}: integrity, identical bytes, OIDC provenance; SHA256 ${artifact.sha256}`)
}

function npmPublish(artifact) {
  const args = ["publish", artifact.path, "--access", "public", "--provenance", "--ignore-scripts", `--registry=${REGISTRY}/`, "--cache", ".forge/local/npm-cache"]
  // npm.cmd is not directly executable with spawnSync on Windows. Do not use a shell.
  const npmCLI = process.platform === "win32"
    ? join(dirname(execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]), "node_modules", "npm", "bin", "npm-cli.js")
    : undefined
  const result = npmCLI ? spawnSync(process.execPath, [npmCLI, ...args], { stdio: "inherit" }) : spawnSync("npm", args, { stdio: "inherit" })
  if (result.error) throw result.error
  return result.status
}

export async function publishArtifact(artifact, { fetchImpl = fetch, publish = npmPublish, wait = sleep } = {}) {
  const existing = await readRegistry(artifact, fetchImpl)
  if (existing) {
    await verifyRegistry(artifact, existing, fetchImpl)
    console.log("Exact version already published with the same artifact; continuing without npm publish.")
    return
  }
  const status = publish(artifact)
  // npm may have accepted publication even if the CLI lost its response. Never
  // repeat that write here; only read the exact public version with bounded delay.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await wait(3000 * attempt)
    const metadata = await readRegistry(artifact, fetchImpl)
    if (metadata) {
      await verifyRegistry(artifact, metadata, fetchImpl)
      return
    }
  }
  throw new Error(`Published version is not visible after bounded reads (npm exit ${status}); inspect the original run, then rerun the same tag. No authentication fallback.`)
}

export function releaseNotes(manifest, changelog) {
  const marker = `## ${manifest.version}\n`
  assert(changelog.includes(marker), "Changelog needs the exact version section")
  const section = changelog.split(marker)[1].split(/\n## /)[0].trim()
  const base = `https://github.com/${REPOSITORY}/blob/v${manifest.version}`
  return `${section}\n\n- [npm ${manifest.version}](https://www.npmjs.com/package/${manifest.name}/v/${manifest.version})\n- [English README](${base}/README.md) · [简体中文说明](${base}/README.zh-CN.md)\n- [Verification boundaries / 测试范围](${base}/docs/verification.md) · [Security / 安全说明](${base}/SECURITY.md)\n\nInstall an exact version when you choose to upgrade; publishing does not update existing pinned installations.\n按需安装指定版本；发布新版本不会升级已有的固定版本安装。\n`
}

export async function finalizeRelease(artifact, { token, commit, notes, fetchImpl = fetch }) {
  assert(token, "The release job needs its scoped GITHUB_TOKEN")
  assert.match(commit, /^[a-f0-9]{40}$/, "Expected the fixed tag commit")
  const api = `https://api.github.com/repos/${REPOSITORY}`
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  const json = async (url, options = {}, missing = false) => {
    const response = await request(fetchImpl, url, { ...options, headers: { ...headers, ...options.headers } })
    if (missing && response.status === 404) return undefined
    assert(response.ok, `GitHub request failed (${response.status})`)
    return response.json()
  }
  const tag = `v${artifact.version}`
  // No API call creates or moves a tag. An existing exact tag must resolve to
  // the checkout's fixed commit before a release is created or touched.
  assert.equal((await json(`${api}/commits/${tag}`)).sha, commit, "Remote tag no longer matches the verified commit")
  // Published releases are visible by tag; drafts are found via the authenticated
  // list so a failed asset upload does not create a second draft on retry.
  let release = await json(`${api}/releases/tags/${tag}`, {}, true)
  if (!release) {
    for (let page = 1; ; page++) {
      const rows = await json(`${api}/releases?per_page=100&page=${page}`)
      const matches = rows.filter((row) => row.tag_name === tag)
      assert(matches.length <= 1, "Conflicting duplicate releases for this tag")
      if (matches.length) { release = matches[0]; break }
      if (rows.length < 100) break
    }
  }
  if (!release) {
    release = await json(`${api}/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: tag, body: notes, draft: true, prerelease: false }),
    })
  }
  assert.equal(release.tag_name, tag)
  assert.equal(release.name, tag, "Existing release title conflicts; do not overwrite")
  assert.equal(release.body, notes, "Existing release notes conflict; do not overwrite")
  assert.equal(release.prerelease, false)
  const assets = await json(`${api}/releases/${release.id}/assets?per_page=100`)
  assert(assets.length < 100, "Unexpected asset count; refusing an incomplete listing")
  const attachments = [[artifact.filename, artifact.bytes], ["SHA256SUMS", artifact.checksum]]
  const checkAsset = async (asset, bytes) => {
    const response = await request(fetchImpl, `${api}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: "application/octet-stream" } })
    assert(response.ok, "Existing asset download failed")
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `Existing release asset conflicts: ${asset.name}; never replace it`)
  }
  const missing = []
  for (const [name, bytes] of attachments) {
    const matches = assets.filter((asset) => asset.name === name)
    assert(matches.length <= 1, "Duplicate release asset")
    if (matches.length) await checkAsset(matches[0], bytes)
    else missing.push([name, bytes])
  }
  // Preflight all existing assets before adding anything to a partial release.
  for (const [name, bytes] of missing) {
    const upload = new URL(release.upload_url.split("{")[0])
    assert.equal(upload.origin, "https://uploads.github.com")
    upload.searchParams.set("name", name)
    await json(upload, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes })
  }
  if (release.draft) {
    await json(`${api}/releases/${release.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: false }),
    })
  }
  // Final authoritative read, including assets, proves the public release exists.
  const completed = await json(`${api}/releases/tags/${tag}`)
  assert.equal(completed.draft, false)
  assert.equal(completed.tag_name, tag)
  assert.equal(completed.name, tag)
  assert.equal(completed.body, notes)
  for (const [name, bytes] of attachments) {
    const matches = completed.assets.filter((asset) => asset.name === name)
    assert.equal(matches.length, 1, `Missing or duplicate public asset ${name}`)
    await checkAsset(matches[0], bytes)
  }
  console.log(`PASS GitHub Release ${completed.html_url}: bilingual notes and verified tarball/checksum assets`)
}

async function main() {
  const [command, directory] = process.argv.slice(2)
  assert(["publish", "verify", "release"].includes(command) && directory && process.argv.length === 4, "Usage: node scripts/release.mjs <publish|verify|release> <artifact-directory>")
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const artifact = loadArtifact(directory, manifest, process.env.GITHUB_REF)
  if (command === "publish") {
    assert(!process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN, "Token publishing is not permitted; use the configured OIDC publisher")
    assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "Publishing requires the GitHub Actions OIDC job")
    return publishArtifact(artifact)
  }
  const metadata = await readRegistry(artifact)
  assert(metadata, "The exact version is not public in npm")
  await verifyRegistry(artifact, metadata)
  if (command === "release") {
    await finalizeRelease(artifact, {
      token: process.env.GITHUB_TOKEN, commit: process.env.GITHUB_SHA,
      notes: releaseNotes(manifest, readFileSync(join(root, "CHANGELOG.md"), "utf8").replaceAll("\r\n", "\n")),
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
