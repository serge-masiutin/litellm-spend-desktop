import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "litellm-build-test-")); directories.push(directory)
  const fakeBin = join(directory, "bin"); mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, "bun"), "#!/bin/sh\nprintf '1.3.12\\n'\n", { mode: 0o755 })
  writeFileSync(join(fakeBin, "swiftc"), "#!/bin/sh\nexit 23\n", { mode: 0o755 })
  const output = join(directory, "Existing App.app")
  const run = () => Bun.spawnSync(["/bin/bash", resolve("desktop/build.sh"), output], { env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin` } })
  return { directory, output, run }
}

test("failed compilation has a nonzero exit status, no app and no leftover staging directory", () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(23)
  expect(existsSync(f.output)).toBe(false)
  expect(readdirSync(f.directory).some((name) => name.startsWith(".litellm-build."))).toBe(false)
})

test("build refuses to overwrite an existing application", () => {
  const f = fixture(); mkdirSync(f.output)
  writeFileSync(join(f.output, "user-file"), "keep")
  expect(f.run().exitCode).not.toBe(0)
  expect(readFileSync(join(f.output, "user-file"), "utf8")).toBe("keep")
})
