import { periodStart } from "./rules.ts"
import type { KeySampleRecord } from "./store.ts"
import { utcDayStart } from "./daily-budget.ts"

const DAY_MS = 86_400_000

interface Samples {
  sampleSize(periodId: string): number | null
  readSamples(periodId: string): KeySampleRecord[]
}

export interface MonthlyEstimate {
  observedSpend: number
  observedDays: number
  days: { day: number; spend: number; source?: "local" | "manual" }[]
  elapsedDays: number
  daysInMonth: number
  firstSampleAt: number
}

interface DailyPeak { spend: number; firstAt: number; source?: "local" | "manual" }

/** Оценка по максимальным показаниям каждого UTC-дня. Это не серверный месячный счётчик. */
export class MonthlyEstimator {
  private readonly cache = new Map<string, { size: number; peak: DailyPeak | null }>()

  constructor(private readonly samples: Samples) {}

  estimate(nowMs: number, resetHourUtc: number, localDay?: (start: number) => DailyPeak | "unavailable" | null): MonthlyEstimate | null {
    const currentDay = localDay === undefined ? periodStart(new Date(nowMs), resetHourUtc) : new Date(utcDayStart(nowMs))
    const year = currentDay.getUTCFullYear()
    const month = currentDay.getUTCMonth()
    const elapsedDays = currentDay.getUTCDate()
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const firstDay = Date.UTC(year, month, 1, resetHourUtc)
    const peaks: DailyPeak[] = []
    const days: MonthlyEstimate["days"] = []
    for (let day = 0; day < elapsedDays; day++) {
      const start = firstDay + day * DAY_MS
      const periodId = String(start)
      const local = localDay?.(start)
      if (local === "unavailable") continue
      if (local != null) {
        peaks.push(local)
        days.push({ day: day + 1, spend: local.spend, source: local.source })
        continue
      }
      const size = this.samples.sampleSize(periodId)
      if (size === null) continue
      const cached = this.cache.get(periodId)
      let peak = cached?.size === size ? cached.peak : undefined
      if (peak === undefined) {
        const records = this.samples.readSamples(periodId)
        peak = this.dailyPeak(records, start)
        this.cache.set(periodId, { size, peak })
      }
      if (peak !== null) {
        peaks.push(peak)
        days.push({ day: day + 1, spend: peak.spend })
      }
    }
    // Ограничиваем кеш текущим месяцем; исходная история остаётся на диске.
    for (const periodId of this.cache.keys()) {
      if (Number(periodId) < firstDay || Number(periodId) >= firstDay + daysInMonth * DAY_MS) this.cache.delete(periodId)
    }
    if (peaks.length === 0) return null
    return {
      observedSpend: peaks.reduce((sum, peak) => sum + peak.spend, 0),
      observedDays: peaks.length,
      days,
      elapsedDays,
      daysInMonth,
      firstSampleAt: Math.min(...peaks.map((peak) => peak.firstAt)),
    }
  }

  private dailyPeak(records: KeySampleRecord[], start: number): DailyPeak | null {
    let peak: DailyPeak | null = null
    for (const sample of records) {
      if (!Number.isFinite(sample.t) || !Number.isFinite(sample.spend) || !Number.isFinite(sample.maxBudget) || sample.maxBudget <= 0 || sample.t < start || sample.t >= start + DAY_MS) {
        throw new Error("invalid stored key sample")
      }
      if (sample.spend < 0) continue
      if (peak === null) peak = { spend: sample.spend, firstAt: sample.t }
      else {
        peak.spend = Math.max(peak.spend, sample.spend)
        peak.firstAt = Math.min(peak.firstAt, sample.t)
      }
    }
    return peak
  }
}
