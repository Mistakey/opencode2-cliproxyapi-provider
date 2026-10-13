#!/usr/bin/env bun
// Validate and install the actual release tarball, never a workspace link.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, ".forge", "local", "package")
const CONSUMER = join(OUT, "consumer")
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
assert.equal(lock.version, manifest.version, "Lock version must match the manifest")
assert.equal(lock.packages[""].version, manifest.version, "Lock root version must match the manifest")
const host = process.argv.includes("--host")
assert(process.argv.slice(2).every((arg) => arg === "--host"), "Only --host is supported")
if (host) assert(process.env.OPENCODE_CLI, "Set OPENCODE_CLI to the real OpenCode 2.0.26 executable")

// npm.cmd cannot be execFile'd on Windows. Run its JS CLI without a shell so
// workspace paths (including spaces) are not interpolated into command text.
const npmCLI = process.platform === "win32"
  ? join(dirname(execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]), "node_modules", "npm", "bin", "npm-cli.js")
  : undefined
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    ...options,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`)
  return result.stdout
}
function npm(args, options = {}) {
  const extra = ["--cache", join(ROOT, ".forge", "local", "npm-cache"), "--no-audit", "--no-fund"]
  return npmCLI
    ? run("node", [npmCLI, ...args, ...extra], options)
    : run("npm", [...args, ...extra], options)
}

mkdirSync(OUT, { recursive: true })
const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", OUT], {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
}))
const files = new Set(packed.files.map((file) => file.path))
const topFiles = new Set(["package.json", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"])
for (const file of files) {
  assert(topFiles.has(file) || /^src\/[\w/-]+\.tsx?$/.test(file) || /^docs\/[\w/.-]+\.md$/.test(file), `Unexpected packed file: ${file}`)
}
for (const file of topFiles) assert(files.has(file), `Missing packed file: ${file}`)
assert.equal(manifest.private, undefined)
assert.equal(manifest.license, "MIT")
assert.equal(manifest.exports["."], "./src/index.ts")
assert.equal(manifest.exports["./tui"], "./src/tui.tsx")
for (const entry of Object.values(manifest.exports)) assert(files.has(entry.replace(/^\.\//, "")), `Missing export: ${entry}`)
assert.equal(manifest.dependencies["@opencode/plugin"], "2.0.26")
assert.deepEqual(Object.keys(manifest.dependencies), ["@opencode/plugin"])
assert.equal(manifest.publishConfig.access, "public")
assert.equal(manifest.repository.url, "git+https://github.com/Mistakey/opencode2-cliproxyapi-provider.git")
for (const key of ["preinstall", "install", "postinstall", "prepare", "prepublishOnly"]) {
  assert(!manifest.scripts[key], `Unexpected consumer/publish lifecycle script: ${key}`)
}

const tarball = join(OUT, packed.filename)
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex")
writeFileSync(join(OUT, "SHA256SUMS"), `${sha256}  ${packed.filename}\n`)
writeFileSync(join(OUT, "pack.json"), `${JSON.stringify(packed, null, 2)}\n`)
console.log(`PASS package allowlist, manifest and exports (${files.size} files)`)

rmSync(CONSUMER, { recursive: true, force: true })
mkdirSync(CONSUMER, { recursive: true })
// Pin the same UI peers used with the tested host. No development dependencies
// or workspace node_modules link are installed into this fresh consumer.
const peers = Object.fromEntries(Object.keys(manifest.peerDependencies).map((name) => [name, manifest.devDependencies[name]]))
writeFileSync(join(CONSUMER, "package.json"), JSON.stringify({
  private: true, type: "module",
  dependencies: { [manifest.name]: `file:${tarball.replaceAll("\\", "/")}`, ...peers },
}, null, 2))
npm(["install", "--omit=dev", "--ignore-scripts"], { cwd: CONSUMER })
const installed = join(CONSUMER, "node_modules", manifest.name)
assert(!lstatSync(installed).isSymbolicLink(), "Package must be installed, not linked")
assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, manifest.version)
// Compare every packed file with the installed copy, not only package.json.
for (const file of files) {
  assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(ROOT, file)), `Installed file differs: ${file}`)
}
const identity = await import(pathToFileURL(join(installed, "src", "host.ts")).href)
assert.equal(identity.PLUGIN_VERSION, manifest.version, "Wire client version must match the manifest")
assert.equal(identity.TESTED_HOST_VERSION, manifest.opencode.tested)
const check = join(CONSUMER, "check-exports.mjs")
writeFileSync(check, `import assert from "node:assert/strict"\nimport server from ${JSON.stringify(manifest.name)}\nimport tui from ${JSON.stringify(`${manifest.name}/tui`)}\nassert.equal(server.id, "opencode2-cliproxyapi-provider")\nassert.equal(tui.id, "opencode2-cliproxyapi-provider.tui")\nassert.equal(typeof server.setup, "function")\nassert.equal(typeof tui.setup, "function")\nconsole.log("PASS installed server and TUI exports (module check, not physical TUI acceptance)")\n`)
run(process.execPath, [check], { cwd: CONSUMER })
if (host) {
  assert(existsSync(process.env.OPENCODE_CLI), "OPENCODE_CLI must be an existing executable path")
  run(process.execPath, [join(ROOT, "scripts", "host-smoke.mjs")], {
    env: {
      ...process.env,
      // 2.0.26 local discovery requires a directory containing index.ts.
      // The npm exports above are checked separately, from this same install.
      OC2CPA_PLUGIN_PATH: dirname(join(installed, manifest.exports["."])),
      OC2CPA_EXPECT_HOST: "2.0.26",
      OC2CPA_SANDBOX: process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "package-host"),
    },
  })
}
console.log(`PASS installed package ${manifest.name}@${manifest.version}\nArtifact: ${tarball}\nSHA256: ${sha256}`)
