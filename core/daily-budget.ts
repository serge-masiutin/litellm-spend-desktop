import type { KeySampleRecord } from "./store.ts"

export const UTC_DAY_MS = 86_400_000
export const utcDayStart = (at: number) => Math.floor(at / UTC_DAY_MS) * UTC_DAY_MS

/** Шаг хранится атомарно вместе с сессией и её дедупликацией. null — цена неизвестна. */
export interface BudgetStep { id: string; at: number; recordedAt: number; cost: number | null }
export interface BudgetCorrection { at: number; amount: number; includedStepIds: string[] }
export interface LocalBudgetInfo {
  source: "local" | "manual"
  gatewaySpend: number | null
  observedSteps: number
  unpricedSteps: number
  firstStepAt: number | null
  correctedAt: number | null
}

export function hasBudgetEstimate(info: LocalBudgetInfo | undefined): boolean {
  return info === undefined || info.source === "manual" || info.observedSteps > info.unpricedSteps
}

export function budgetStepsForDay(steps: BudgetStep[], start: number): BudgetStep[] {
  return steps.filter((step) => step.at >= start && step.at < start + UTC_DAY_MS)
}

/**
 * Отрицательное показание включает резерв на весь UTC-день. Серверные суммы не
 * складываются с локальными: ответ HTTP и окончание шага приходят в разное время.
 * Поправка заменяет итог уже учтённых шагов, а не прибавляется к нему.
 */
export function localDayBudget(start: number, raw: KeySampleRecord[], steps: BudgetStep[], correction: BudgetCorrection | null) {
  if (correction === null && !raw.some((sample) => sample.spend < 0)) return null
  const daySteps = budgetStepsForDay(steps, start)
  const included = new Set(correction?.includedStepIds ?? [])
  const pending = daySteps.filter((step) => !included.has(step.id)).sort((a, b) => a.recordedAt - b.recordedAt || a.id.localeCompare(b.id))
  let spend = correction?.amount ?? 0
  const points = [{ t: correction?.at ?? start, spend }]
  for (const step of pending) {
    spend += step.cost ?? 0
    // Запоздавший шаг относится к дню выполнения, не к дню получения события.
    points.push({ t: Math.min(start + UTC_DAY_MS - 1, Math.max(points[points.length - 1].t, step.recordedAt)), spend })
  }
  const latest = raw[raw.length - 1]
  const info: LocalBudgetInfo = {
    source: correction === null ? "local" : "manual",
    gatewaySpend: latest?.spend ?? null,
    observedSteps: daySteps.length,
    unpricedSteps: pending.filter((step) => step.cost === null).length,
    firstStepAt: daySteps.length === 0 ? null : Math.min(...daySteps.map((step) => step.at)),
    correctedAt: correction?.at ?? null,
  }
  return { spend, points, info }
}

export function parseBudgetDay(day: string, nowMs: number): number {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day || start > utcDayStart(nowMs)) {
    throw new Error("Дата поправки: ожидается существующий день YYYY-MM-DD в UTC, не в будущем")
  }
  return start
}
