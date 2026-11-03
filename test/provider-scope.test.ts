import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionEvents, type SessionEvent } from "../adapters/opencode/session-events.ts"
import { ModelCatalog } from "../core/catalog.ts"
import { parseConfig } from "../core/config.ts"
import { Monitor } from "../core/monitor.ts"
import { Store, ACCOUNTING_VERSION } from "../core/store.ts"
import { parseKeyHeaders } from "../core/litellm.ts"
import { formatReport, formatShort } from "../core/format.ts"
import { sessionTotals } from "../core/session-totals.ts"
import defaults from "../config.defaults.json"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "litellm-scope-"))
  dirs.push(dir)
  const configPath = join(dir, "config.json")
  writeFileSync(configPath, JSON.stringify(defaults))
  const cfg = parseConfig(defaults)
  const store = new Store(dir)
  writeFileSync(join(dir, "settings.json"), '{"mode":"off"}')
  const monitor = new Monitor(configPath, new ModelCatalog(null, join(dir, "models.json"), () => 60), async () => {}, cfg, store)
  let reads = 0
  const reader = { get: async () => {
    reads++
    // OpenCode отдаёт общие итоги, включая прямых провайдеров. Адаптер не должен их копировать.
    return { title: "test", location: { directory: "/project" }, cost: 1000, tokens: { input: 999999 } }
  } }
  const adapter = new SessionEvents("litellm", monitor, reader)
  return { dir, store, monitor, adapter, cfg, reads: () => reads }
}

function started(id: string, providerID = "litellm", sessionID = "s1"): SessionEvent {
  return { type: "session.step.started", id: `start-${id}`, created: Date.now(), data: { sessionID, assistantMessageID: id, model: { providerID, id: "same-model" } } }
}
function ended(id: string, sessionID = "s1"): SessionEvent {
  return { type: "session.step.ended", id: `end-${id}`, created: Date.now(), data: { sessionID, assistantMessageID: id, cost: 0.01, tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 50, write: 5 } } } }
}
function execution(type: string, sessionID = "s1"): SessionEvent {
  return { type: `session.execution.${type}`, id: type, created: Date.now(), data: { sessionID } }
}

describe("изоляция LiteLLM в адаптере OpenCode", () => {
  test("вложенные сабагенты учитываются один раз без чужих провайдеров", async () => {
    const f = fixture()
    const parents: Record<string, string | undefined> = { root: undefined, child: "root", grandchild: "child" }
    const adapter = new SessionEvents("litellm", f.monitor, { get: async ({ sessionID }) => ({ title: sessionID, location: { directory: "/project" }, parentID: parents[sessionID] }) })
    for (const id of ["root", "child", "grandchild"]) {
      await adapter.handle(started(id, "litellm", id))
      await adapter.handle(ended(id, id))
    }
    await adapter.handle(started("foreign", "openai", "grandchild"))
    await adapter.handle(ended("foreign", "grandchild"))
    const records = f.store.listSessions().records
    expect(f.store.readSession("grandchild")!.ancestorIds).toEqual(["child", "root"])
    expect(sessionTotals(records).get("root")!.cost).toBeCloseTo(.03)
    expect(sessionTotals(records).get("child")!.cost).toBeCloseTo(.02)
    expect(sessionTotals(records).get("root")!.descendants).toBe(2)
    expect(formatReport({ key: null, sessions: records, corrupt: [], alerts: [], nowMs: Date.now(), cfg: f.cfg })).toContain("с известными сабагентами (2) ≈ $0.03")
  })

  test("недоступный предок не теряет стоимость собственного шага", async () => {
    const f = fixture()
    const adapter = new SessionEvents("litellm", f.monitor, { get: async ({ sessionID }) => {
      if (sessionID === "root") throw new Error("unavailable")
      return { location: { directory: "/project" }, parentID: "root" }
    } })
    await adapter.handle(started("a", "litellm", "child"))
    await adapter.handle(ended("a", "child"))
    expect(f.store.readSession("child")!.cost).toBeCloseTo(.01)
    expect(f.store.readSession("child")!.ancestryComplete).toBe(false)
    expect(f.store.readSession("child")!.ancestorIds).toEqual(["root"])
  })
  test("execution.started без провайдера не помечает сессию активной", async () => {
    const f = fixture()
    await f.adapter.handle(execution("started"))
    expect(readdirSync(join(f.dir, "running"))).toEqual([])
  })
  test("чужой провайдер с тем же именем модели не пишет расходы, активность и оповещения", async () => {
    const f = fixture()
    await f.adapter.handle(execution("started"))
    await f.adapter.handle(started("a", "openai"))
    await f.adapter.handle(ended("a"))
    expect(f.reads()).toBe(0)
    expect(f.store.listSessions().records).toEqual([])
    expect(readdirSync(join(f.dir, "running"))).toEqual([])
    expect(readdirSync(join(f.dir, "steps"))).toEqual([])
    expect(existsSync(join(f.dir, "alerts.jsonl"))).toBe(false)
    expect(existsSync(join(f.dir, "status.json"))).toBe(false)
  })
  test("LiteLLM → прямой провайдер → LiteLLM: сумма и токены только своих шагов", async () => {
    const f = fixture()
    await f.adapter.handle(started("a"))
    expect(existsSync(join(f.dir, "running/s1.json"))).toBe(true)
    await f.adapter.handle(ended("a"))
    await f.adapter.handle(started("b", "openai"))
    expect(existsSync(join(f.dir, "running/s1.json"))).toBe(false)
    await f.adapter.handle(ended("b"))
    await f.adapter.handle(started("c"))
    expect(existsSync(join(f.dir, "running/s1.json"))).toBe(true)
    await f.adapter.handle(ended("c"))
    const session = f.store.readSession("s1")!
    expect(session.cost).toBeCloseTo(0.02)
    expect(session.steps).toBe(2)
    expect(session.tokens).toEqual({ input: 200, output: 20, reasoning: 4, cache: { read: 100, write: 10 } })
    expect(f.reads()).toBe(2)
    expect(f.store.readAlerts(100)).toEqual([])
  })
  for (const type of ["succeeded", "failed", "interrupted"]) {
    test(`${type} снимает активность LiteLLM`, async () => {
      const f = fixture()
      await f.adapter.handle(started("a"))
      await f.adapter.handle(execution(type))
      expect(existsSync(join(f.dir, "running/s1.json"))).toBe(false)
    })
  }
  test("параллельная чужая сессия не снимает активность LiteLLM", async () => {
    const f = fixture()
    await f.adapter.handle(started("a"))
    await f.adapter.handle(started("b", "openai", "s2"))
    await f.adapter.handle(execution("succeeded", "s2"))
    expect(existsSync(join(f.dir, "running/s1.json"))).toBe(true)
  })
  test("два экземпляра адаптера не удваивают сумму шага", async () => {
    const f = fixture()
    const second = new SessionEvents("litellm", f.monitor, { get: async () => ({ location: { directory: "/project" } }) })
    await f.adapter.handle(started("a"))
    await second.handle(started("a"))
    await f.adapter.handle(ended("a"))
    await second.handle(ended("a"))
    expect(f.store.readSession("s1")!.steps).toBe(1)
    expect(f.store.readSession("s1")!.cost).toBeCloseTo(0.01)
  })
  test("более 200 чужих шагов не вытесняют модель незаконченного шага LiteLLM", async () => {
    const f = fixture()
    await f.adapter.handle(started("a"))
    for (let i = 0; i < 201; i++) await f.adapter.handle(started(`foreign-${i}`, "other", `s${i + 2}`))
    await f.adapter.handle(ended("a"))
    expect(f.store.readSession("s1")!.steps).toBe(1)
  })
  test("неизвестная модель после перезагрузки не угадывается по текущему выбору", async () => {
    const f = fixture()
    await expect(f.adapter.handle(ended("unknown"))).rejects.toThrow("no model recorded")
    expect(f.store.listSessions().records).toEqual([])
  })
  test("после reload провайдер берётся из сообщения завершённого шага", async () => {
    const f = fixture()
    const reader = { get: async () => ({ location: { directory: "/project" } }), context: async () => [
      { id: "a", type: "assistant", model: { providerID: "litellm", id: "same-model" } },
      { id: "b", type: "assistant", model: { providerID: "openai", id: "same-model" } },
    ] }
    const adapter = new SessionEvents("litellm", f.monitor, reader)
    await adapter.handle(ended("a"))
    await adapter.handle(ended("b"))
    expect(f.store.readSession("s1")!.steps).toBe(1)
    expect(f.store.readSession("s1")!.cost).toBeCloseTo(.01)
    const second = new SessionEvents("litellm", f.monitor, reader)
    await second.handle(ended("a"))
    expect(f.store.readSession("s1")!.steps).toBe(1)
  })
  test("старые смешанные записи и оповещения исключены, файл истории сохранён", async () => {
    const f = fixture()
    await f.adapter.handle(started("old"))
    await f.adapter.handle(ended("old"))
    const old = { ...f.store.readSession("s1")!, accountingVersion: undefined, cost: 1000 }
    f.store.writeSession(old)
    expect(f.store.readSession("s1")).toBeNull()
    expect(f.store.listSessions().records).toEqual([])
    expect(existsSync(join(f.dir, "sessions/s1.json"))).toBe(true)
    f.store.appendAlert({ at: Date.now(), severity: "warn", title: "legacy", body: "" })
    expect(f.store.readAlerts(10)).toEqual([])
    await f.adapter.handle(started("new"))
    await f.adapter.handle(ended("new"))
    expect(f.store.readSession("s1")!.cost).toBeCloseTo(0.01)
    expect(f.store.readSession("s1")!.accountingVersion).toBe(ACCOUNTING_VERSION)
    expect(existsSync(join(f.dir, "legacy-sessions/s1.json"))).toBe(true)
  })
  test("отчёт исключает явно чужую запись", async () => {
    const f = fixture()
    await f.adapter.handle(started("a"))
    await f.adapter.handle(ended("a"))
    const foreign = { ...f.store.readSession("s1")!, title: "FOREIGN-SESSION", model: { providerID: "openai", id: "same-model" } }
    expect(formatReport({ key: null, sessions: [foreign], corrupt: [], alerts: [], nowMs: Date.now(), cfg: f.cfg })).not.toContain("FOREIGN-SESSION")
  })
})

test("частичные заголовки не превращаются в ложный нулевой расход или сброс бюджета", () => {
  expect(parseKeyHeaders(new Headers({ "x-litellm-key-max-budget": "200" }))).toBeNull()
  expect(parseKeyHeaders(new Headers({ "x-litellm-key-spend": "", "x-litellm-key-max-budget": "200" }))).toBeNull()
  expect(parseKeyHeaders(new Headers({ "x-litellm-key-spend": "NaN", "x-litellm-key-max-budget": "200" }))).toBeNull()
  expect(parseKeyHeaders(new Headers({ "x-litellm-key-spend": "0", "x-litellm-key-max-budget": "200" }))).toEqual({ spend: 0, maxBudget: 200 })
})

test("отрицательное показание после UTC-сброса обновляет период, а не оставляет вчерашний статус", async () => {
  const f = fixture()
  const clock = spyOn(Date, "now")
  try {
    clock.mockReturnValue(Date.UTC(2026, 9, 24, 23, 59))
    await f.monitor.onKeySample(198, 200)
    clock.mockReturnValue(Date.UTC(2026, 9, 25, 0, 1))
    const reading = parseKeyHeaders(new Headers({ "x-litellm-key-spend": "-184.50577", "x-litellm-key-max-budget": "200" }))!
    expect(reading).toEqual({ spend: -184.50577, maxBudget: 200 })
    await f.monitor.onKeySample(reading.spend, reading.maxBudget)
    const status = JSON.parse(readFileSync(join(f.dir, "status.json"), "utf8"))
    expect(status.periodStartAt).toBe(Date.UTC(2026, 9, 25))
    expect(status.nextResetAt).toBe(Date.UTC(2026, 9, 26))
    expect(status.spend).toBe(0)
    expect(status.budget.gatewaySpend).toBe(reading.spend)
    expect(status.budget.source).toBe("local")
    const view = f.monitor.currentKeyView(Date.now())!
    expect(view.sample.spend).toBe(0)
    expect(formatShort(view, view.nowMs)).toContain("Локальная оценка: учтено шагов LiteLLM: 0")
    expect(formatShort(view, view.nowMs)).toContain("LiteLLM сообщил $-184.51")
    clock.mockReturnValue(Date.UTC(2026, 9, 25, 0, 20))
    await f.monitor.onKeySample(5, 200)
    expect(f.monitor.currentKeyView(Date.now())!.sample.spend).toBe(0)
    expect(f.monitor.currentKeyView(Date.now())!.budget!.gatewaySpend).toBe(5)
  } finally { clock.mockRestore() }
})

test("машинный хвост после сброса не становится аномалией или отрицательным нулём", async () => {
  const f = fixture()
  for (const rawSpend of ["-2.842170943040401e-14", "-0", "0", String(-Number.EPSILON * 200)]) {
    const reading = parseKeyHeaders(new Headers({ "x-litellm-key-spend": rawSpend, "x-litellm-key-max-budget": "200" }))!
    expect(reading).toEqual({ spend: 0, maxBudget: 200 })
    expect(Object.is(reading.spend, -0)).toBe(false)
    await f.monitor.onKeySample(reading.spend, reading.maxBudget)
    const status = JSON.parse(readFileSync(join(f.dir, "status.json"), "utf8"))
    expect(status.spend).toBe(0)
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).not.toContain("отрицательный расход")
  }
})

test("допуск нуля не скрывает отрицательный расход и не округляет положительные показания", () => {
  for (const spend of [-Number.EPSILON * 200 * 2, -0.000001, -184.50577, 0.000001, 3.2614]) {
    expect(parseKeyHeaders(new Headers({ "x-litellm-key-spend": String(spend), "x-litellm-key-max-budget": "200" })))
      .toEqual({ spend, maxBudget: 200 })
  }
})
