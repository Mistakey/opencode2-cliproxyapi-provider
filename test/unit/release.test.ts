import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
// The Node-only publishing script has no runtime dependencies or credentials in tests.
// @ts-expect-error JS release helper is outside the source TypeScript project
import { finalizeRelease, loadArtifact, publishArtifact, releaseNotes, verifyRegistry } from "../../scripts/release.mjs"

const bytes = Buffer.from("fictional verified tarball")
const artifact = {
  name: "opencode2-cliproxyapi-provider", version: "0.1.1",
  filename: "opencode2-cliproxyapi-provider-0.1.1.tgz", bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  checksum: Buffer.from("fictional checksum\n"),
}
const metadata = {
  name: artifact.name, version: artifact.version,
  dist: { integrity: artifact.integrity, tarball: "https://registry.npmjs.org/fixture.tgz", attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const tarballResponse = () => new Response(bytes)

// Only mock the HTTP/process boundaries; all checksum, conflict and retry logic is real.
describe("immutable npm publication", () => {
  test("validates the exact tag and every artifact identity before a write", () => {
    const directory = join(process.cwd(), ".forge/local/tmp/release-test")
    mkdirSync(directory, { recursive: true })
    try {
      writeFileSync(join(directory, artifact.filename), bytes)
      writeFileSync(join(directory, "SHA256SUMS"), `${artifact.sha256}  ${artifact.filename}\n`)
      writeFileSync(join(directory, "pack.json"), JSON.stringify(artifact))
      expect(loadArtifact(directory, artifact, "refs/tags/v0.1.1").sha256).toBe(artifact.sha256)
      expect(() => loadArtifact(directory, artifact, "refs/heads/main")).toThrow("Tag must equal")
      writeFileSync(join(directory, "SHA256SUMS"), `${artifact.sha256}  wrong.tgz\n`)
      expect(() => loadArtifact(directory, artifact, "refs/tags/v0.1.1")).toThrow("checksum/name mismatch")
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test("a successful exact-version retry verifies bytes and never republishes", async () => {
    let writes = 0
    await publishArtifact(artifact, {
      fetchImpl: async (url: URL | string) => String(url).endsWith(".tgz") ? tarballResponse() : response(metadata),
      publish: () => { writes++; return 0 },
    })
    expect(writes).toBe(0)
  })

  test("different published content stops before any write", async () => {
    let writes = 0
    await expect(publishArtifact(artifact, {
      fetchImpl: async () => response({ ...metadata, dist: { ...metadata.dist, integrity: "sha512-conflict" } }),
      publish: () => { writes++; return 0 },
    })).rejects.toThrow("conflicts with verified artifact")
    expect(writes).toBe(0)
    await expect(verifyRegistry(artifact, metadata, async () => new Response("different bytes"))).rejects.toThrow("Public tarball differs")
  })

  test("registry outage is not interpreted as permission to publish", async () => {
    let writes = 0
    await expect(publishArtifact(artifact, {
      fetchImpl: async () => response({}, 503), publish: () => { writes++; return 0 },
    })).rejects.toThrow("absence is only HTTP 404")
    expect(writes).toBe(0)
  })

  test("uncertain npm response reconciles eventual public success without a second write", async () => {
    let reads = 0
    let writes = 0
    const waits: number[] = []
    await publishArtifact(artifact, {
      fetchImpl: async (url: URL | string) => {
        if (String(url).endsWith(".tgz")) return tarballResponse()
        return ++reads < 3 ? response({}, 404) : response(metadata)
      },
      publish: () => { writes++; return 1 }, wait: async (ms: number) => { waits.push(ms) },
    })
    expect(writes).toBe(1)
    expect(waits).toEqual([3000])
  })

  test("missing provenance or changed tarball origin cannot pass OIDC verification", async () => {
    await expect(verifyRegistry(artifact, { ...metadata, dist: { ...metadata.dist, attestations: undefined } }, async () => tarballResponse())).rejects.toThrow("OIDC provenance is required")
    await expect(verifyRegistry(artifact, { ...metadata, dist: { ...metadata.dist, tarball: "https://other.test/a.tgz" } }, async () => tarballResponse())).rejects.toThrow("public npm registry")
  })

  test("an absent post-publish version ends after bounded reads with no fallback write", async () => {
    let reads = 0
    let writes = 0
    await expect(publishArtifact(artifact, {
      fetchImpl: async () => { reads++; return response({}, 404) },
      publish: () => { writes++; return 1 }, wait: async () => {},
    })).rejects.toThrow("No authentication fallback")
    expect(reads).toBe(7)
    expect(writes).toBe(1)
  })
})

const commit = "a".repeat(40)
const notes = "English release notes / 中文发布说明"
function githubFixture({ draft = true, conflict = false, failUpload = false, tagCommit = commit, body = notes, exists = true } = {}) {
  const release = {
    id: 1, tag_name: "v0.1.1", name: "v0.1.1", body, draft, prerelease: false,
    upload_url: "https://uploads.github.com/repos/Mistakey/opencode2-cliproxyapi-provider/releases/1/assets{?name,label}",
    html_url: "https://github.com/Mistakey/opencode2-cliproxyapi-provider/releases/tag/v0.1.1",
    assets: exists ? [{ id: 10, name: artifact.filename }] : [],
  }
  const writes: string[] = []
  const fetchImpl = async (url: URL | string, options: RequestInit = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith("/commits/v0.1.1")) return response({ sha: tagCommit })
    if (path.endsWith("/releases/tags/v0.1.1")) return !exists || release.draft ? response({}, 404) : response(release)
    if (path.endsWith("/releases") && !options.method) return response(exists ? [release] : [])
    if (path.endsWith("/releases") && options.method === "POST") {
      const input = JSON.parse(String(options.body))
      expect(input).toEqual({ tag_name: "v0.1.1", target_commitish: commit, name: "v0.1.1", body: notes, draft: true, prerelease: false })
      writes.push("create draft")
      exists = true
      return response(release)
    }
    if (path.endsWith("/releases/1/assets") && options.method === "POST") {
      writes.push("upload")
      if (failUpload) return response({}, 503)
      const name = new URL(url).searchParams.get("name")!
      expect(Buffer.from(options.body as Uint8Array)).toEqual(name === artifact.filename ? bytes : artifact.checksum)
      const id = name === artifact.filename ? 10 : 11
      release.assets.push({ id, name })
      return response({ id })
    }
    if (path.endsWith("/releases/1/assets")) return response(release.assets)
    if (path.endsWith("/releases/assets/10")) return new Response(conflict ? "conflicting tgz" : bytes)
    if (path.endsWith("/releases/assets/11")) return new Response(artifact.checksum)
    if (path.endsWith("/releases/1") && options.method === "PATCH") {
      writes.push("finalize")
      release.draft = false
      return response(release)
    }
    throw new Error(`Unexpected mock GitHub request: ${url}`)
  }
  return { fetchImpl, writes, release }
}

describe("GitHub Release safe finalization", () => {
  test("a new release starts as a draft and verifies both attachment bytes before completing", async () => {
    const fixture = githubFixture({ exists: false })
    await finalizeRelease(artifact, { token: "fictional", commit, notes, fetchImpl: fixture.fetchImpl })
    expect(fixture.writes).toEqual(["create draft", "upload", "upload", "finalize"])
    expect(fixture.release.assets.map((asset) => asset.name)).toEqual([artifact.filename, "SHA256SUMS"])
  })

  test("a partial draft resumes, preserves its matching asset, and publishes only after attachments", async () => {
    const fixture = githubFixture()
    await finalizeRelease(artifact, { token: "fictional", commit, notes, fetchImpl: fixture.fetchImpl })
    expect(fixture.writes).toEqual(["upload", "finalize"])
    expect(fixture.release.draft).toBe(false)
    fixture.writes.length = 0
    await finalizeRelease(artifact, { token: "fictional", commit, notes, fetchImpl: fixture.fetchImpl })
    expect(fixture.writes).toEqual([])
  })

  test("changed tags, notes or attachment bytes stop without overwrite", async () => {
    for (const options of [{ tagCommit: "b".repeat(40) }, { body: "conflicting notes" }, { conflict: true }]) {
      const fixture = githubFixture(options)
      await expect(finalizeRelease(artifact, { token: "fictional", commit, notes, fetchImpl: fixture.fetchImpl })).rejects.toThrow()
      expect(fixture.writes).toEqual([])
    }
  })

  test("asset upload failure leaves the draft unpublished for a retry", async () => {
    const fixture = githubFixture({ failUpload: true })
    await expect(finalizeRelease(artifact, { token: "fictional", commit, notes, fetchImpl: fixture.fetchImpl })).rejects.toThrow("GitHub request failed")
    expect(fixture.writes).toEqual(["upload"])
    expect(fixture.release.draft).toBe(true)
  })

  test("notes link to both versioned READMEs and retain honest verification boundaries", () => {
    const text = releaseNotes(artifact, "# Changelog\n\n## 0.1.1\n\nEnglish / 中文\n\n## 0.1.0\nOld\n")
    expect(text).toContain("English / 中文")
    expect(text).toContain("blob/v0.1.1/README.zh-CN.md")
    expect(text).toContain("blob/v0.1.1/docs/verification.md")
    expect(text).toContain("does not update existing pinned installations")
    expect(text).not.toContain("Old")
  })

  test("workflow publication and repository-write permissions stay in separate manual-tag jobs", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/publish.yml"), "utf8").replaceAll("\r\n", "\n")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toMatch(/^  (push|pull_request):/m)
    const [, publishing, release] = workflow.split(/\n  (?:publish|release):\n/)
    expect(publishing).toContain("id-token: write")
    expect(publishing).not.toContain("contents: write")
    expect(release).toContain("contents: write")
    expect(release).not.toContain("id-token: write")
  })
})
