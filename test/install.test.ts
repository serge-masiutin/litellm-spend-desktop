import { afterEach, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "litellm-install-test-")); directories.push(path)
  const source = join(path, "package"); mkdirSync(source)
  for (const item of ["core", "adapters", "bin"]) { mkdirSync(join(source, item)); writeFileSync(join(source, item, "version.txt"), "new") }
  writeFileSync(join(source, "bin/litellm-spend.ts"), "cli")
  for (const item of ["index.ts", "tui.ts", "package.json", "README.md", "config.defaults.json", "connect-telegram.command"]) writeFileSync(join(source, item), item)
  cpSync(resolve("install.sh"), join(source, "install.sh"))
  const target = join(path, "existing plugin")
  return { path, source, target, run: () => Bun.spawnSync(["/bin/sh", join(source, "install.sh"), target]) }
}

test("installer preserves config and unknown files and saves the previous installation", () => {
  const f = fixture(); mkdirSync(f.target)
  writeFileSync(join(f.target, "config.json"), "personal-config")
  writeFileSync(join(f.target, "custom.txt"), "user-work")
  writeFileSync(join(f.target, "index.ts"), "old")
  const result = f.run()
  expect(result.exitCode).toBe(0)
  expect(readFileSync(join(f.target, "config.json"), "utf8")).toBe("personal-config")
  expect(readFileSync(join(f.target, "custom.txt"), "utf8")).toBe("user-work")
  expect(readFileSync(join(f.target, "core/version.txt"), "utf8")).toBe("new")
  expect(existsSync(join(f.target, "bin/version.txt"))).toBe(false)
  const backup = readdirSync(f.path).find((name) => name.startsWith(".litellm-spend-backup."))!
  expect(readFileSync(join(f.path, backup, "previous/index.ts"), "utf8")).toBe("old")
})

test("incomplete installer payload fails without changing the existing installation", () => {
  const f = fixture(); mkdirSync(f.target)
  writeFileSync(join(f.target, "index.ts"), "old")
  rmSync(join(f.source, "adapters"), { recursive: true })
  expect(f.run().exitCode).not.toBe(0)
  expect(readFileSync(join(f.target, "index.ts"), "utf8")).toBe("old")
  expect(readdirSync(f.path).some((name) => name.startsWith(".litellm-spend-install."))).toBe(false)
})

test("fresh installation has default config and needs no test or development files", () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(0)
  expect(readFileSync(join(f.target, "config.json"), "utf8")).toBe("config.defaults.json")
  expect(existsSync(join(f.target, "test"))).toBe(false)
})
