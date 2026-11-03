import { afterEach, expect, test, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Monitor, type StepEvent } from "../core/monitor.ts"
import { ModelCatalog } from "../core/catalog.ts"
import { Store } from "../core/store.ts"
import { parseConfig } from "../core/config.ts"
import defaults from "../config.defaults.json"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spend-concurrent-"))
  directories.push(dir)
  const config = join(dir, "config.json")
  writeFileSync(config, JSON.stringify(defaults))
  const store = new Store(dir)
  const monitor = new Monitor(config, new ModelCatalog(null, join(dir, "models.json"), () => 60), async () => {}, parseConfig(defaults), store)
  const event: StepEvent = { id: "one", sessionId: "shared", sessionTitle: "test", directory: "/test", at: 1000, model: { id: "unknown" }, reportedStepCost: .01, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
  return { dir, config, store, monitor, event }
}

test("параллельные процессы не теряют разные шаги и не удваивают повторные", async () => {
  const f = fixture()
  const moduleURL = pathToFileURL(join(import.meta.dir, "../core/monitor.ts")).href
  const worker = `
    import { Monitor } from ${JSON.stringify(moduleURL)};
    import { Store } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../core/store.ts")).href)};
    import { ModelCatalog } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../core/catalog.ts")).href)};
    const input = JSON.parse(await Bun.stdin.text());
    const monitor = new Monitor(input.config, new ModelCatalog(null, input.dir + '/models.json', () => 60), async () => {}, input.cfg, new Store(input.dir));
    for (let i = 0; i < 50; i++) {
      await monitor.onStep({ ...input.event, id: 'event-' + i });
      await monitor.onStep({ ...input.event, id: 'unique-' + input.worker + '-' + i });
    }
  `
  const processes = Array.from({ length: 6 }, (_, workerID) => Bun.spawn([process.execPath, "-e", worker], { stdin: Buffer.from(JSON.stringify({ dir: f.dir, config: f.config, event: f.event, worker: workerID, cfg: parseConfig(defaults) })), stdout: "pipe", stderr: "pipe" }))
  const results = await Promise.all(processes.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })))
  for (const result of results) expect(result).toEqual({ code: 0, error: "" })
  expect(f.store.readSession("shared")!.steps).toBe(350)
  expect(f.store.readSession("shared")!.cost).toBeCloseTo(3.5)
  expect(f.store.readSession("shared")!.tokens.input).toBe(350)
}, 15000)

test("ошибка записи не помечает шаг выполненным; повтор можно сохранить", async () => {
  const f = fixture()
  const write = spyOn(f.store, "writeSession").mockImplementationOnce(() => { throw new Error("disk failure") })
  await expect(f.monitor.onStep(f.event)).rejects.toThrow("disk failure")
  write.mockRestore()
  await f.monitor.onStep(f.event)
  expect(f.store.readSession("shared")!.steps).toBe(1)
})

test("дедупликация остаётся в записи после удаления временной отметки", async () => {
  const f = fixture()
  await f.monitor.onStep(f.event)
  unlinkSync(join(f.dir, "steps", "one"))
  await f.monitor.onStep(f.event)
  expect(f.store.readSession("shared")!.steps).toBe(1)
})

test("частичная цепочка после перезагрузки не стирает известных предков", async () => {
  const f = fixture()
  await f.monitor.onStep({ ...f.event, ancestorIds: ["parent", "root"], ancestryComplete: true })
  await f.monitor.onStep({ ...f.event, id: "two", ancestorIds: ["parent"], ancestryComplete: false })
  expect(f.store.readSession("shared")!.ancestorIds).toEqual(["parent", "root"])
  expect(f.store.readSession("shared")!.ancestryComplete).toBe(true)
})

test("ingest отклоняет повреждённое родство до записи сессии", () => {
  const f = fixture()
  writeFileSync(f.config, JSON.stringify({ ...defaults, notify: { ...defaults.notify, channels: [] }, litellm: { ...defaults.litellm, keyEnv: "SPEND_TEST_ABSENT", keyFile: join(f.dir, "absent-key") }, storage: { dir: f.dir } }))
  for (const extra of [{ ancestorIds: 1 }, { ancestorIds: ["../invalid"] }, { ancestorIds: ["shared"] }, { ancestryComplete: "yes" }]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/litellm-spend.ts"), "ingest", "--config", f.config], { env: { ...process.env, SPEND_TEST_ABSENT: "", LITELLM_SPEND_DIR: f.dir }, stdin: Buffer.from(JSON.stringify({ ...f.event, ...extra })), stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toMatch(/ingest: (ancestorIds|ancestryComplete)/)
    expect(f.store.readSession("shared")).toBeNull()
  }
})
