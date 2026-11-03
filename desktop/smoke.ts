import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseProfile } from "../adapters/telegram/contract.ts"
import { initialState, saveJson } from "../adapters/telegram/state.ts"
import defaults from "../config.defaults.json"

const app = resolve(process.argv[2] ?? "desktop/build.noindex/LiteLLM Spend.app")
const temporary = mkdtempSync(join(tmpdir(), "litellm-desktop-smoke-"))
const storage = join(temporary, "data")
const config = join(temporary, "config.json")
const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LITELLM_SPEND_CONFIG: config, LITELLM_SPEND_DIR: storage, LITELLM_API_KEY: "", SMOKE_ABSENT_KEY: "" }

function run(executable: string, args: string[], input?: string): string {
  const result = Bun.spawnSync([executable, ...args], { env, stdin: input === undefined ? undefined : Buffer.from(input), timeout: 30_000 })
  assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

try {
  writeFileSync(config, JSON.stringify({ ...defaults, planningBudget: { monthlyUsd: 4000 }, storage: { dir: storage }, notify: { ...defaults.notify, channels: [] }, litellm: { ...defaults.litellm, keyFile: join(temporary, "absent-key"), keyEnv: "SMOKE_ABSENT_KEY" } }))
  const native = join(app, "Contents/MacOS/OpenCodeSpend")
  const cli = join(app, "Contents/MacOS/litellm-spend")
  assert.match(run(native, ["--self-test"]), /Desktop self-test: OK/)
  assert.match(run(native, ["--login-status"]), /^(enabled|disabled)\s*$/)
  assert.match(run(cli, ["--help"]), /usage: litellm-spend/)
  run(cli, ["ingest-key"], JSON.stringify({ spend: 42, maxBudget: 200 }))
  const firstStatus = JSON.parse(readFileSync(join(storage, "status.json"), "utf8"))
  assert.equal(firstStatus.spend, 42)
  assert.deepEqual(firstStatus.monthlyEstimate.days, [{ day: new Date(firstStatus.periodStartAt).getUTCDate(), spend: 42 }])
  const telegram = join(storage, "telegram")
  mkdirSync(telegram, { mode: 0o700 })
  const profile = parseProfile({ version: 1, botId: 12345, owner: { userId: 42, chatId: 42 }, deviceName: "smoke", timeZone: "UTC", tokenFile: join(telegram, "absent-token") })
  const state = initialState(storage, profile)
  state.enabled = false
  saveJson(join(telegram, "profile.json"), profile)
  saveJson(join(telegram, "state.json"), state)
  assert.equal(JSON.parse(run(cli, ["telegram", "status"])).notifications, "off")
  assert.equal(JSON.parse(readFileSync(join(telegram, "state.json"), "utf8")).enabled, false)
  const snapshots = join(temporary, "snapshots")
  run(native, ["--snapshot", snapshots, "--data-dir", storage])
  for (const theme of ["light", "dark"]) {
    assert.ok(existsSync(join(snapshots, `window-${theme}.png`)))
    assert.ok(existsSync(join(snapshots, `daily-correction-${theme}.png`)))
    assert.ok(existsSync(join(snapshots, `thresholds-${theme}.png`)))
    for (const width of [520, 600]) {
      assert.ok(existsSync(join(snapshots, `settings-${width}-${theme}.png`)))
      assert.ok(existsSync(join(snapshots, `monthly-${width}-${theme}.png`)))
    }
  }
  run(cli, ["ingest-key"], JSON.stringify({ spend: -184.50577, maxBudget: 200 }))
  const negative = JSON.parse(readFileSync(join(storage, "status.json"), "utf8"))
  assert.equal(negative.spend, 0)
  assert.equal(negative.budget.source, "local")
  assert.equal(negative.budget.gatewaySpend, -184.50577)
  assert.equal(negative.budget.observedSteps, 0)
  run(native, ["--snapshot", join(temporary, "negative-budget"), "--data-dir", storage])
  const today = new Date().toISOString().slice(0, 10)
  run(cli, ["correct-day", today, "125.50"])
  const corrected = JSON.parse(readFileSync(join(storage, "status.json"), "utf8"))
  assert.equal(corrected.spend, 125.5)
  assert.equal(corrected.budget.source, "manual")
  assert.equal(corrected.monthlyEstimate.observedSpend, 125.5)
  run(cli, ["ingest"], JSON.stringify({ id: "smoke-local-step", at: Date.now(), sessionId: "smoke-session", sessionTitle: "Smoke local budget", directory: "/fixture", model: { id: "fixture" }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, reportedStepCost: 2 }))
  assert.equal(JSON.parse(readFileSync(join(storage, "status.json"), "utf8")).spend, 127.5)
  assert.match(run(cli, ["status"]), /Ручная поправка \+ новые шаги/)
  run(native, ["--snapshot", join(temporary, "corrected-budget"), "--data-dir", storage])
  run(cli, ["ingest-key"], JSON.stringify({ headers: { "x-litellm-key-spend": "-2.842170943040401e-14", "x-litellm-key-max-budget": "200" } }))
  assert.equal(JSON.parse(readFileSync(join(storage, "status.json"), "utf8")).spend, 127.5)
  assert.doesNotMatch(run(cli, ["status"]), /отрицательный расход|\$-0\.00/)
  console.log("Desktop smoke: OK (native self-test, bundled runtime, local budget, daily correction, manual Telegram, light/dark rendering). No network or live services used.")
} finally { rmSync(temporary, { recursive: true, force: true }) }
