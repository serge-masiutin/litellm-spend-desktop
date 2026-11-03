import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelCatalog } from "../core/catalog.ts"
import { parseConfig } from "../core/config.ts"
import { parseBudgetDay, UTC_DAY_MS } from "../core/daily-budget.ts"
import { formatShort } from "../core/format.ts"
import { Monitor, type StepEvent } from "../core/monitor.ts"
import { Store } from "../core/store.ts"
import defaults from "../config.defaults.json"

const dirs: string[] = []
const start = Date.UTC(2026, 10, 2)
const clock = spyOn(Date, "now")
afterEach(() => {
  clock.mockReturnValue(start + 12 * 3600000)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
})

function fixture(resetHourUtc = 0) {
  clock.mockReturnValue(start + 12 * 3600000)
  const dir = mkdtempSync(join(tmpdir(), "litellm-daily-budget-"))
  dirs.push(dir)
  const config = join(dir, "config.json")
  const raw = { ...defaults, keyBudget: { ...defaults.keyBudget, resetHourUtc }, planningBudget: { monthlyUsd: 4000 } }
  writeFileSync(config, JSON.stringify(raw))
  const cfg = parseConfig(raw)
  const store = new Store(dir)
  const catalog = new ModelCatalog(null, join(dir, "models.json"), () => 60)
  const monitor = new Monitor(config, catalog, async () => {}, cfg, store)
  const status = () => JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
  const step = (id: string, cost: number | undefined = 2, at = Date.now(), sessionId = "root"): StepEvent => ({
    id, at, sessionId, sessionTitle: sessionId, directory: "/project", model: { id: "test-model" },
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } },
    ...(cost === undefined ? {} : { reportedStepCost: cost }),
  })
  return { dir, store, monitor, status, step, config, catalog, cfg }
}

describe("резервный дневной бюджет", () => {
  test("здоровый счётчик остаётся источником истины, локальные шаги не прибавляются", async () => {
    const f = fixture()
    await f.monitor.onKeySample(80, 300)
    await f.monitor.onStep(f.step("one", 5))
    expect(f.status().spend).toBe(80)
    expect(f.status().budget).toBeUndefined()
  })

  test("после сбоя считает весь день, а не серверный итог плюс шаги; восстановление липкое", async () => {
    const f = fixture()
    await f.monitor.onStep(f.step("one", 5))
    await f.monitor.onKeySample(80, 300)
    await f.monitor.onKeySample(-150, 300)
    await f.monitor.onStep(f.step("two", 3))
    await f.monitor.onKeySample(999, 300)
    expect(f.status().spend).toBe(8)
    expect(f.status().budget).toMatchObject({ source: "local", gatewaySpend: 999, observedSteps: 2 })
    expect(f.status().monthlyEstimate.observedSpend).toBe(8)
    expect(f.store.readSamples(String(start)).map((sample) => sample.spend)).toEqual([80, -150, 999])
    const restarted = new Monitor(f.config, f.catalog, async () => {}, f.cfg, new Store(f.dir))
    expect(restarted.currentKeyView(Date.now())!.sample.spend).toBe(8)
  })

  test("дедупликация и параллельные сессии не удваивают бюджет и сабагентов", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    const other = new Monitor(f.config, f.catalog, async () => {}, f.cfg, new Store(f.dir))
    const parent = f.step("one", 5)
    const child = { ...f.step("two", 3, Date.now(), "child"), ancestorIds: ["root"] }
    await Promise.all([f.monitor.onStep(parent), other.onStep(parent), other.onStep(child)])
    expect(f.monitor.currentKeyView(Date.now())!.sample.spend).toBe(8)
    expect(f.status().spend).toBe(8)
    expect(f.store.readSession("root")!.budgetSteps).toHaveLength(1)
  })

  test("в полночь возвращается серверный режим, вчерашний сбой не влияет", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    await f.monitor.onStep(f.step("old", 20))
    clock.mockReturnValue(start + UTC_DAY_MS + 60000)
    await f.monitor.onKeySample(7, 300)
    expect(f.status().budget).toBeUndefined()
    expect(f.status().spend).toBe(7)
    expect(f.status().monthlyEstimate.days).toEqual([{ day: 2, spend: 20, source: "local" }, { day: 3, spend: 7 }])
  })

  test("поправка заменяет итог, допускает снижение и ноль; новые шаги прибавляются один раз", async () => {
    const f = fixture()
    await f.monitor.onKeySample(200, 300)
    await f.monitor.onStep(f.step("one", 5))
    await f.monitor.correctDailyBudget("2026-11-02", 100)
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).toContain("После поправки новых учтённых расходов нет")
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).not.toContain("За последний час расхода нет")
    await f.monitor.onStep(f.step("two", 3))
    expect(f.status().spend).toBe(103)
    await f.monitor.onKeySample(250, 300)
    expect(f.status().spend).toBe(103)
    await f.monitor.correctDailyBudget("2026-11-02", 10)
    expect(f.status().spend).toBe(10)
    expect(f.status().monthlyEstimate.observedSpend).toBe(10)
    expect(f.status().forecast.ratePerHour).toBe(0)
    expect(f.status().budgetSamples.map((sample: { spend: number }) => sample.spend)).toEqual([10])
    await f.monitor.correctDailyBudget("2026-11-02", 0)
    await f.monitor.onStep(f.step("three", 2))
    expect(f.status().spend).toBe(2)
  })

  test("поправка прошлого дня меняет месяц, а не сегодняшнюю сумму", async () => {
    const f = fixture()
    f.store.appendSample(String(start - UTC_DAY_MS), { t: start - 1000, spend: 500, maxBudget: 300 })
    await f.monitor.onKeySample(20, 300)
    expect(f.status().monthlyEstimate.observedSpend).toBe(520)
    await f.monitor.correctDailyBudget("2026-11-01", 40)
    expect(f.status().spend).toBe(20)
    expect(f.status().budget).toBeUndefined()
    expect(f.status().monthlyEstimate.observedSpend).toBe(60)
    expect(f.status().monthlyEstimate.days).toEqual([{ day: 1, spend: 40, source: "manual" }, { day: 2, spend: 20 }])
  })

  test("поздний шаг после поправки относится к своему дню, даже после полуночи", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    await f.monitor.correctDailyBudget("2026-11-02", 40)
    clock.mockReturnValue(start + UTC_DAY_MS + 60000)
    await f.monitor.onKeySample(7, 300)
    await f.monitor.onStep(f.step("late", 3, start + 3600000))
    expect(f.status().spend).toBe(7)
    expect(f.status().monthlyEstimate.observedSpend).toBe(50)
  })

  test("неизвестная цена видна как неполнота; поправка покрывает старые неизвестные шаги", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    const step = f.step("unknown")
    delete step.reportedStepCost
    await f.monitor.onStep(step)
    expect(f.status().budget.unpricedSteps).toBe(1)
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).toContain("Шагов с неизвестной ценой: 1")
    await f.monitor.correctDailyBudget("2026-11-02", 10)
    expect(f.status().budget.unpricedSteps).toBe(0)
  })

  test("цена каталога LiteLLM приоритетнее стоимости агента", async () => {
    const f = fixture()
    writeFileSync(join(f.dir, "models.json"), JSON.stringify({ version: 2, specs: [{ id: "test-model", tiers: [{ fromTokens: null, input: 10, output: 20, cacheRead: 1, cacheWrite: 10 }] }] }))
    await f.catalog.refresh()
    await f.monitor.onKeySample(-5, 300)
    await f.monitor.onStep(f.step("priced", 999))
    expect(f.status().spend).toBeCloseTo(.00145)
  })

  test("UTC-день резерва не меняется при настроенном сбросе ключа в 04:00", async () => {
    const f = fixture(4)
    clock.mockReturnValue(start + 3600000)
    await f.monitor.onKeySample(-5, 300)
    await f.monitor.onStep(f.step("early", 3))
    expect(f.status().monthlyEstimate.days).toEqual([{ day: 2, spend: 3, source: "local" }])
    clock.mockReturnValue(start + 5 * 3600000)
    await f.monitor.onKeySample(20, 300)
    expect(f.status().budget.source).toBe("local")
    expect(f.status().periodStartAt).toBe(start)
    expect(f.status().nextResetAt).toBe(start + UTC_DAY_MS)
  })

  test("поправка и шаг из другого процесса сериализуются без потерь", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    const other = new Monitor(f.config, f.catalog, async () => {}, f.cfg, new Store(f.dir))
    await Promise.all([f.monitor.correctDailyBudget("2026-11-02", 40), other.onStep(f.step("parallel", 3))])
    expect(f.monitor.currentKeyView(Date.now())!.sample.spend).toBe(43)
  })

  test("сверка вчерашнего дня обновляет месяц даже до первого сегодняшнего запроса", async () => {
    const f = fixture()
    await f.monitor.onKeySample(100, 300)
    clock.mockReturnValue(start + UTC_DAY_MS + 60000)
    await f.monitor.correctDailyBudget("2026-11-02", 40)
    expect(f.status().monthlyEstimate.observedSpend).toBe(40)
    // Не выдаём вчерашний расход и время за сегодняшние показания.
    expect(f.status().periodStartAt).toBe(start)
    expect(f.status().spend).toBe(100)
    expect(f.monitor.currentKeyView(Date.now())).toBeNull()
  })

  test("пороговые алерты в резерве используют локальную сумму и помечают источник", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    await f.monitor.onStep(f.step("costly", 275))
    const alerts = f.store.readAlertHistory(Infinity).filter((alert) => alert.kind === "budget")
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain("Локальная оценка. Потрачено $275.00 из $300.00")
    await f.monitor.onKeySample(999, 300)
    expect(f.store.readAlertHistory(Infinity).filter((alert) => alert.kind === "budget")).toHaveLength(1)
  })

  test("без локальных шагов нет прогноза по выдуманной нулевой истории", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    expect(f.status().forecast).toBeNull()
    expect(f.status().budgetSamples).toEqual([])
    expect(f.status().monthlyEstimate).toBeNull()
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).not.toContain("За последний час расхода нет")
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).toContain("остаток и прогноз пока недоступны")
    expect(formatShort(f.monitor.currentKeyView(Date.now()), Date.now())).not.toContain("осталось $300")
  })

  test("повтор события восстанавливает статус после сбоя публикации, не повторяя стоимость", async () => {
    const f = fixture()
    await f.monitor.onKeySample(-5, 300)
    const publish = spyOn(f.store, "writeStatus").mockImplementationOnce(() => { throw new Error("publication failed") })
    const step = f.step("committed", 3)
    try { await expect(f.monitor.onStep(step)).rejects.toThrow("publication failed") } finally { publish.mockRestore() }
    expect(f.store.readSession("root")!.cost).toBe(3)
    await f.monitor.onStep(step)
    expect(f.status().spend).toBe(3)
    expect(f.store.readSession("root")!.budgetSteps).toHaveLength(1)
  })

  test("битая поправка и некорректный ввод не маскируются нулём", async () => {
    const f = fixture()
    for (const amount of [-1, NaN, Infinity]) await expect(f.monitor.correctDailyBudget("2026-11-02", amount)).rejects.toThrow()
    for (const day of ["2026-02-30", "2026-11-03", "", "../../bad"]) expect(() => parseBudgetDay(day, Date.now())).toThrow()
    writeFileSync(join(f.dir, "budget-corrections", `${start}.json`), '{"amount":-1}')
    expect(() => f.monitor.currentKeyView(Date.now())).toThrow("invalid stored budget correction")
  })
})

// Date.now — внешняя граница. Возвращаем часы после всех сценариев этого файла.
afterAll(() => clock.mockRestore())
