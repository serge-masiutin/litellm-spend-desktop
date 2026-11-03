import type { Config } from "./config.ts"

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface KeySample {
  t: number
  spend: number
}

export interface Forecast {
  /** Расход ключа на момент расчёта: накопленный максимум показаний. */
  spend: number
  ratePerHour: number
  /** null — за окно расхода не было, при таком темпе лимит не закончится. */
  hoursToExhaust: number | null
}

const DAY_MS = 86_400_000

/** Начало суточного периода бюджета: последний сброс в resetHourUtc:00 UTC. */
export function periodStart(now: Date, resetHourUtc: number): Date {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc)
  return new Date(start > now.getTime() ? start - DAY_MS : start)
}

export function nextReset(now: Date, resetHourUtc: number): Date {
  return new Date(periodStart(now, resetHourUtc).getTime() + DAY_MS)
}

export function crossed(value: number, thresholds: number[]): number[] {
  return thresholds.filter((threshold) => value >= threshold).sort((a, b) => a - b)
}

export function sessionStepUsd(outputPricePerMillion: number | undefined, cfg: Config["session"]): number {
  if (outputPricePerMillion === undefined) return cfg.unpricedStepUsd
  const tier = cfg.tiers.find((candidate) => outputPricePerMillion >= candidate.minOutputPricePerMillion)
  if (!tier) throw new Error(`no session cost tier for output price ${outputPricePerMillion}`)
  return tier.stepUsd
}

export function sessionCostLevels(cost: number, stepUsd: number): number[] {
  const count = Math.floor(cost / stepUsd)
  return Array.from({ length: count }, (_, index) => Number(((index + 1) * stepUsd).toFixed(2)))
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function isSpike(stepCost: number, history: number[], cfg: Config["spike"]): boolean {
  if (history.length < cfg.minSteps || stepCost < cfg.minStepUsd) return false
  return stepCost > cfg.multiplier * median(history)
}

/**
 * Параллельные ответы приходят не по порядку, и заголовок может нести старое показание.
 * Расход ключа внутри периода не убывает, поэтому берём накопленный максимум.
 * Показание ≤ 0 — сброс на шлюзе или аномалия: максимум считается заново.
 * Ту же огибающую строит панель: desktop/Sources/DailyPace.swift.
 */
export function keyEnvelope<T extends KeySample>(samples: T[]): T[] {
  const result: T[] = []
  for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
    const previous = result[result.length - 1]
    result.push(previous === undefined || sample.spend <= 0 ? sample : { ...sample, spend: Math.max(previous.spend, sample.spend) })
  }
  return result
}

/**
 * Темп — прирост огибающей за последние `windowMinutes` по часам, а не по запросам:
 * пауза снижает темп до нуля. Окно не начинается раньше периода и не короче
 * `minSpanMinutes`. null — только при отсутствии или аномалии показаний.
 * Панель повторяет расчёт в desktop/Sources/DailyPace.swift с параметрами из status.json.
 */
export function forecastKey(samples: KeySample[], nowMs: number, periodStartMs: number, maxBudget: number, cfg: Config["forecast"]): Forecast | null {
  const envelope = keyEnvelope(samples)
  const last = envelope[envelope.length - 1]
  if (last === undefined || last.spend < 0) return null
  const restart = envelope.findLastIndex((sample) => sample.spend <= 0)
  const segment = restart < 0 ? envelope : envelope.slice(envelope[restart].spend < 0 ? restart + 1 : restart)
  const windowStart = Math.max(nowMs - cfg.windowMinutes * 60_000, periodStartMs)
  // До первого показания в окне запросов этого ключа отсюда не было: база — первое показание.
  const baseline = segment.findLast((sample) => sample.t <= windowStart)?.spend ?? segment[0].spend
  const hours = Math.max(nowMs - windowStart, cfg.minSpanMinutes * 60_000) / 3_600_000
  const ratePerHour = Math.max(0, last.spend - baseline) / hours
  return { spend: last.spend, ratePerHour, hoursToExhaust: ratePerHour === 0 ? null : Math.max(0, maxBudget - last.spend) / ratePerHour }
}

export function contextTokens(tokens: Tokens): number {
  // OpenCode 2.x: input — nonCachedInputTokens; кеш не входит в input и добавляется ровно один раз.
  return tokens.input + tokens.cache.read + tokens.cache.write
}

export function cacheReadRatio(tokens: Tokens): number {
  const total = contextTokens(tokens)
  return total === 0 ? 1 : tokens.cache.read / total
}

export function nextCacheStreak(previous: number, tokens: Tokens, cfg: Config["cache"]): number {
  const lowCache = contextTokens(tokens) >= cfg.minContextTokens && cacheReadRatio(tokens) < cfg.minReadRatio
  return lowCache ? previous + 1 : 0
}

export interface ContextLevel {
  tokens: number
  isPriceTier: boolean
}

export function contextLevels(tokens: number, priceTierSize: number | undefined, cfg: Config["context"]): ContextLevel[] {
  const levels: ContextLevel[] = cfg.thresholdsTokens.map((value) => ({ tokens: value, isPriceTier: false }))
  if (priceTierSize !== undefined) {
    levels.push({ tokens: Math.floor(priceTierSize * cfg.tierWarnFraction), isPriceTier: true })
  }
  return levels.filter((level) => tokens >= level.tokens).sort((a, b) => a.tokens - b.tokens)
}

/** Сколько раз расход ключа упал внутри периода: значит, LiteLLM сбросил бюджет раньше расчётного времени. */
export function countResets(samples: KeySample[], minDropUsd = 1): number {
  let resets = 0
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1].spend - samples[index].spend >= minDropUsd) resets++
  }
  return resets
}

export function samplesSinceLastReset<T extends KeySample>(samples: T[], minDropUsd = 1): T[] {
  let start = 0
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1].spend - samples[index].spend >= minDropUsd) start = index
  }
  return samples.slice(start)
}

/** «all» — всё; «critical» — только критичные; «off» — ничего. */
export function shouldNotify(severity: "info" | "warn" | "critical", mode: "all" | "critical" | "off"): boolean {
  if (mode === "off") return false
  if (mode === "critical") return severity === "critical"
  return true
}
