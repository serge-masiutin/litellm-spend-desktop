import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MonthlyEstimator } from "../core/monthly.ts"
import { Store } from "../core/store.ts"
import { ModelCatalog } from "../core/catalog.ts"
import { parseConfig } from "../core/config.ts"
import { Monitor } from "../core/monitor.ts"
import defaults from "../config.defaults.json"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "litellm-month-"))
  dirs.push(dir)
  const store = new Store(dir)
  return { store, estimator: new MonthlyEstimator(store), dir }
}

const day = (n: number) => Date.UTC(2026, 9, n)

describe("локальная месячная оценка", () => {
  test("берёт максимум одного дня один раз, обозначает пропущенные дни", () => {
    const { store, estimator } = fixture()
    for (const spend of [20, 18, 20, 25, 23]) store.appendSample(String(day(3)), { t: day(3) + 3600000, spend, maxBudget: 200 })
    store.appendSample(String(day(5)), { t: day(5) + 3600000, spend: 40, maxBudget: 200 })
    expect(estimator.estimate(day(5) + 7200000, 0)).toEqual({
      observedSpend: 65, observedDays: 2, days: [{ day: 3, spend: 25 }, { day: 5, spend: 40 }], elapsedDays: 5, daysInMonth: 31, firstSampleAt: day(3) + 3600000,
    })
  })

  test("отрицательные значения не становятся нулевым расходом", () => {
    const { store, estimator } = fixture()
    store.appendSample(String(day(1)), { t: day(1) + 1, spend: -150, maxBudget: 200 })
    expect(estimator.estimate(day(1) + 100, 0)).toBeNull()
    store.appendSample(String(day(1)), { t: day(1) + 2, spend: 0, maxBudget: 200 })
    expect(estimator.estimate(day(1) + 100, 0)?.days).toEqual([{ day: 1, spend: 0 }])
  })

  test("дневные максимумы упорядочены, не заполняют пропуски и согласованы с итогом", () => {
    const { store, estimator } = fixture()
    store.appendSample(String(day(5)), { t: day(5) + 2, spend: 10, maxBudget: 200 })
    store.appendSample(String(day(1)), { t: day(1) + 2, spend: 0, maxBudget: 200 })
    store.appendSample(String(day(3)), { t: day(3) + 1, spend: -1, maxBudget: 200 })
    store.appendSample(String(day(5)), { t: day(5) + 1, spend: 15, maxBudget: 200 })
    const estimate = estimator.estimate(day(5) + 100, 0)
    expect(estimate).not.toBeNull()
    expect(estimate!.days).toEqual([{ day: 1, spend: 0 }, { day: 5, spend: 15 }])
    expect(estimate!.days.reduce((sum, entry) => sum + entry.spend, 0)).toBe(estimate!.observedSpend)
    expect(estimate!.observedDays).toBe(2)
  })

  test("поздняя запись пересчитывается без двойного учёта; начало месяца сбрасывает оценку", () => {
    const { store, estimator } = fixture()
    const readSamples = spyOn(store, "readSamples")
    store.appendSample(String(day(31)), { t: day(31) + 1, spend: 12, maxBudget: 200 })
    expect(estimator.estimate(day(31) + 100, 0)?.observedSpend).toBe(12)
    expect(estimator.estimate(day(31) + 100, 0)?.days).toEqual([{ day: 31, spend: 12 }])
    expect(readSamples).toHaveBeenCalledTimes(1)
    store.appendSample(String(day(31)), { t: day(31) + 2, spend: 20, maxBudget: 200 })
    expect(estimator.estimate(day(31) + 100, 0)?.observedSpend).toBe(20)
    expect(readSamples).toHaveBeenCalledTimes(2)
    const nextMonth = Date.UTC(2026, 10, 1)
    expect(estimator.estimate(nextMonth, 0)).toBeNull()
    store.appendSample(String(nextMonth), { t: nextMonth + 1, spend: 3, maxBudget: 200 })
    expect(estimator.estimate(nextMonth + 100, 0)).toEqual({ observedSpend: 3, observedDays: 1, days: [{ day: 1, spend: 3 }], elapsedDays: 1, daysInMonth: 30, firstSampleAt: nextMonth + 1 })
  })

  test("начало дня следует настроенному UTC-сбросу", () => {
    const { store, estimator } = fixture()
    const last = day(31) + 4 * 3600000
    store.appendSample(String(last), { t: last + 1000, spend: 5, maxBudget: 200 })
    const november = Date.UTC(2026, 10, 1)
    expect(estimator.estimate(november + 3 * 3600000, 4)?.elapsedDays).toBe(31)
    store.appendSample(String(last), { t: november + 3 * 3600000, spend: 7, maxBudget: 200 })
    expect(estimator.estimate(november + 3 * 3600000, 4)?.days).toEqual([{ day: 31, spend: 7 }])
    expect(estimator.estimate(november + 4 * 3600000, 4)).toBeNull()
  })

  test("повреждённое показание не превращается в ноль", () => {
    const estimator = new MonthlyEstimator({ sampleSize: () => 1, readSamples: () => [{ t: day(1), spend: NaN, maxBudget: 200 }] })
    expect(() => estimator.estimate(day(1) + 100, 0)).toThrow("invalid stored key sample")
  })

  test("очистка временных файлов не удаляет исторические показания", () => {
    const { store, dir } = fixture()
    store.appendSample(String(day(1)), { t: day(1) + 1, spend: 12, maxBudget: 200 })
    const old = new Date(Date.now() - 500 * 86400000)
    utimesSync(join(dir, "samples", `${day(1)}.jsonl`), old, old)
    store.prune(Date.now())
    expect(store.readSamples(String(day(1)))).toHaveLength(1)
  })

  test("колебания счётчика не открывают пороги бюджета заново", async () => {
    const { store, dir } = fixture()
    const config = join(dir, "config.json")
    writeFileSync(config, JSON.stringify(defaults))
    const monitor = new Monitor(config, new ModelCatalog(null, join(dir, "models.json"), () => 60), async () => {}, parseConfig(defaults), store)
    await monitor.onKeySample(160, 200)
    await monitor.onKeySample(155, 200)
    await monitor.onKeySample(160, 200)
    expect(store.readAlertHistory(Infinity).filter((alert) => alert.kind === "budget")).toHaveLength(1)
  })

  test("монитор публикует месячный бюджет и неполную оценку без подмены лимита ключа", async () => {
    const { store, dir } = fixture()
    const raw = { ...defaults, planningBudget: { dailyUsd: 200, monthlyUsd: 4000 } }
    const config = join(dir, "config.json")
    writeFileSync(config, JSON.stringify(raw))
    const monitor = new Monitor(config, new ModelCatalog(null, join(dir, "models.json"), () => 60), async () => {}, parseConfig(raw), store)
    store.appendSample(String(day(3)), { t: day(3) + 3600000, spend: 25, maxBudget: 200 })
    const clock = spyOn(Date, "now").mockReturnValue(day(5) + 3600000)
    try {
      await monitor.onKeySample(40, 300)
      const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
      expect(status.maxBudget).toBe(300)
      expect(status.planningBudget).toEqual({ monthlyUsd: 4000 })
      expect(status.monthlyEstimate).toEqual({ observedSpend: 65, observedDays: 2, days: [{ day: 3, spend: 25 }, { day: 5, spend: 40 }], elapsedDays: 5, daysInMonth: 31, firstSampleAt: day(3) + 3600000 })
      expect(status.monthlyError).toBeNull()
    } finally { clock.mockRestore() }
  })
})
