import {
  existsSync,
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Tokens } from "./rules.ts"
import type { BudgetCorrection, BudgetStep } from "./daily-budget.ts"
import type { MonthlyEstimate } from "./monthly.ts"

export interface KeySampleRecord {
  t: number
  /** Исходный счётчик LiteLLM; отрицательное значение — аномалия шлюза, а не нулевой расход. */
  spend: number
  maxBudget: number
}

export type Severity = "info" | "warn" | "critical"

export interface AlertRecord {
  notificationsSuppressed?: boolean
  id?: string
  kind?: "budget" | "forecast" | "session-cost" | "spike" | "context" | "cache"
  accountingVersion?: number
  at: number
  severity: Severity
  title: string
  subtitle?: string
  body: string
}

export interface SessionRecord {
  lastStepRisk?: { expensiveInput: boolean; windowFull: boolean; cacheLoss: boolean; spike: boolean; priceTier: boolean }
  lastStepTokens?: Tokens
  lastStepCharges?: import("./pricing.ts").StepCharges | null
  accountingVersion?: number
  id: string
  title: string
  directory: string
  /** Родители от непосредственного до корневого; отсутствует у старых записей. */
  ancestorIds?: string[]
  ancestryComplete?: boolean
  /** Дедупликация коммитится атомарно вместе с собственной суммой. */
  appliedStepIds?: string[]
  budgetSteps?: BudgetStep[]
  model: { providerID: string; id: string; variant?: string }
  cost: number
  tokens: Tokens
  steps: number
  lastStepAt: number
  lastStepCost: number
  contextTokens: number
  contextLimit?: number
  cacheReadRatio: number
  cacheStreak: number
  stepCosts: number[]
}

export type NotifyMode = "all" | "critical" | "off"

export interface NotifySettings {
  mode: NotifyMode
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { mode: "all" }
// Старые итоги могли включать других провайдеров. Храним их на диске, но не используем в новом учёте.
export const ACCOUNTING_VERSION = 2
const NOTIFY_MODES: readonly string[] = ["all", "critical", "off"]

export type ClaimBucket = "fired" | "steps"

const DAY_MS = 86_400_000
// Показания и сессии нужны для истории; при очистке временных записей их не удаляем.
const MAX_AGE_MS: Record<string, number> = { fired: 14 * DAY_MS, steps: 2 * DAY_MS, running: DAY_MS }
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

/**
 * Файловое хранилище, общее для всех экземпляров плагина (по одному на каждую папку проекта).
 * Атомарность даёт создание файла с флагом wx (замки) и одиночный append (журналы).
 */
export class Store {
  constructor(readonly dir: string) {
    for (const name of ["fired", "steps", "sessions", "samples", "running", "budget-corrections"]) mkdirSync(join(dir, name), { recursive: true })
  }

  claim(key: string, bucket: ClaimBucket = "fired"): boolean {
    try {
      closeSync(openSync(join(this.dir, bucket, encodeURIComponent(key)), "wx"))
      return true
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") return false
      throw error
    }
  }

  /** Все новые писатели держат замок сессии до атомарного rename. Не отбираем замок по возрасту. */
  async withSessionLock<T>(id: string, update: () => T): Promise<T> {
    return this.withFileLock(`${this.sessionFile(id)}.lock`, update)
  }

  /** Общий замок сериализует поправки, шаги и публикацию бюджета между процессами. */
  async withBudgetLock<T>(update: () => T | Promise<T>): Promise<T> {
    return this.withFileLock(join(this.dir, "budget.lock"), update)
  }

  private async withFileLock<T>(lock: string, update: () => T | Promise<T>): Promise<T> {
    const deadline = performance.now() + 5000
    let descriptor: number
    for (;;) {
      try {
        descriptor = openSync(lock, "wx", 0o600)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (performance.now() >= deadline) throw new Error(`write lock timeout: ${lock}; check for an interrupted writer before removing its lock`, { cause: error })
        await delay(10)
      }
    }
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: Date.now() }))
      return await update()
    } finally {
      closeSync(descriptor)
      unlinkSync(lock)
    }
  }

  readBudgetCorrection(start: number): BudgetCorrection | null {
    let text: string
    try { text = readFileSync(join(this.dir, "budget-corrections", `${start}.json`), "utf8") } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const value = JSON.parse(text) as BudgetCorrection
    if (value === null || typeof value !== "object" || !Number.isFinite(value.at) || !Number.isFinite(value.amount) || value.amount < 0 || !Array.isArray(value.includedStepIds) || value.includedStepIds.some((id) => typeof id !== "string")) {
      throw new Error("invalid stored budget correction")
    }
    return value
  }

  writeBudgetCorrection(start: number, correction: BudgetCorrection): void {
    const file = join(this.dir, "budget-corrections", `${start}.json`)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(correction), { mode: 0o600 })
    renameSync(temp, file)
  }

  readBudgetSteps(providerID: string): BudgetStep[] {
    const listed = this.listSessions()
    if (listed.corrupt.length > 0) throw new Error("Cannot calculate local budget: unreadable session records")
    const steps = listed.records.filter((session) => session.model.providerID === providerID).flatMap((session) => session.budgetSteps ?? [])
    for (const step of steps) {
      if (typeof step.id !== "string" || !Number.isFinite(step.at) || !Number.isFinite(step.recordedAt) || (step.cost !== null && (!Number.isFinite(step.cost) || step.cost < 0))) throw new Error("invalid stored budget step")
    }
    return steps
  }

  stepApplied(id: string, previous: SessionRecord | null): boolean {
    return previous?.appliedStepIds?.includes(id) === true || existsSync(join(this.dir, "steps", encodeURIComponent(id)))
  }

  appendSample(periodId: string, sample: KeySampleRecord): void {
    appendFileSync(join(this.dir, "samples", `${periodId}.jsonl`), `${JSON.stringify(sample)}\n`)
  }

  readSamples(periodId: string): KeySampleRecord[] {
    return readLines(join(this.dir, "samples", `${periodId}.jsonl`)).map((line) => {
      const sample = JSON.parse(line) as KeySampleRecord
      if (sample === null || !Number.isFinite(sample.t) || !Number.isFinite(sample.spend) || !Number.isFinite(sample.maxBudget) || sample.maxBudget <= 0) throw new Error("invalid stored key sample")
      return sample
    })
  }

  sampleSize(periodId: string): number | null {
    try {
      return statSync(join(this.dir, "samples", `${periodId}.jsonl`)).size
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  latestSample(periodId: string): KeySampleRecord | null {
    const samples = this.readSamples(periodId)
    return samples.length === 0 ? null : samples[samples.length - 1]
  }

  writeSession(record: SessionRecord): void {
    const file = this.sessionFile(record.id)
    // Перед первым пересчётом сохраняем прежний смешанный итог; не пытаемся вычесть чужие расходы задним числом.
    let previous: string | undefined
    try {
      previous = readFileSync(file, "utf8")
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    if (previous !== undefined && (JSON.parse(previous) as SessionRecord).accountingVersion !== ACCOUNTING_VERSION) {
      const archive = join(this.dir, "legacy-sessions")
      mkdirSync(archive, { recursive: true })
      try {
        writeFileSync(join(archive, `${record.id}.json`), previous, { flag: "wx" })
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error
      }
    }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(record))
    renameSync(temp, file)
  }

  readSession(id: string): SessionRecord | null {
    try {
      const record = JSON.parse(readFileSync(this.sessionFile(id), "utf8")) as SessionRecord
      return record.accountingVersion === ACCOUNTING_VERSION ? record : null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  listSessions(): { records: SessionRecord[]; corrupt: string[] } {
    const records: SessionRecord[] = []
    const corrupt: string[] = []
    for (const name of readdirSync(join(this.dir, "sessions"))) {
      if (!name.endsWith(".json")) continue
      try {
        const record = JSON.parse(readFileSync(join(this.dir, "sessions", name), "utf8")) as SessionRecord
        if (record.accountingVersion === ACCOUNTING_VERSION) records.push(record)
      } catch {
        corrupt.push(name)
      }
    }
    return { records, corrupt }
  }

  /** Файл пишет приложение в строке меню. Отсутствие файла — штатное состояние (всё включено). */
  readSettings(): NotifySettings {
    let text: string
    try {
      text = readFileSync(join(this.dir, "settings.json"), "utf8")
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_NOTIFY_SETTINGS
      throw error
    }
    const parsed = JSON.parse(text) as Partial<NotifySettings>
    if (typeof parsed.mode !== "string" || !NOTIFY_MODES.includes(parsed.mode)) {
      throw new Error('settings.json: expected { mode: "all" | "critical" | "off" }')
    }
    return { mode: parsed.mode as NotifyMode }
  }

  notificationsPaused(): boolean {
    return existsSync(join(this.dir, "notifications-off"))
  }

  activity(id: string, nowMs: number): "running" | "unknown" | "idle" {
    let text: string
    try {
      text = readFileSync(this.runningFile(id), "utf8")
    } catch (error) {
      if (isNotFound(error)) return "idle"
      throw error
    }
    const mark = JSON.parse(text) as { at: number; accountingVersion?: number }
    if (mark.accountingVersion !== ACCOUNTING_VERSION) return "unknown"
    if (!Number.isFinite(mark.at)) throw new Error("invalid running mark")
    return nowMs - mark.at < 30 * 60_000 ? "running" : "unknown"
  }

  /** Сессия выполняется прямо сейчас. Файл обновляют все экземпляры плагина одинаково, поэтому запись идемпотентна. */
  markRunning(id: string): void {
    writeFileSync(this.runningFile(id), JSON.stringify({ at: Date.now(), accountingVersion: ACCOUNTING_VERSION }))
  }

  clearRunning(id: string): void {
    try {
      unlinkSync(this.runningFile(id))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  writeStatus(status: unknown): void {
    const file = join(this.dir, "status.json")
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(status))
    renameSync(temp, file)
  }

  /** Поправка прошлого дня должна обновлять месяц и без новых заголовков сегодня. */
  updateStatusMonthly(monthlyEstimate: MonthlyEstimate | null): void {
    let text: string
    try { text = readFileSync(join(this.dir, "status.json"), "utf8") } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    const status = JSON.parse(text) as Record<string, unknown>
    if (status === null || typeof status !== "object" || !Number.isFinite(status.updatedAt) || !Number.isFinite(status.spend) || !Number.isFinite(status.maxBudget)) throw new Error("invalid stored budget status")
    this.writeStatus({ ...status, monthlyEstimate, monthlyError: null })
  }

  appendAlert(alert: AlertRecord): void {
    appendFileSync(join(this.dir, "alerts.jsonl"), `${JSON.stringify(alert)}\n`)
  }

  /** Приложение в строке меню пишет сюда, какие оповещения очищены: всё, что раньше clearedBefore, и отдельные по времени. */
  readDismissed(): { clearedBefore: number; dismissed: number[] } {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, "dismissed.json"), "utf8")) as { clearedBefore?: unknown; dismissed?: unknown }
      if (typeof parsed.clearedBefore !== "number" || !Array.isArray(parsed.dismissed)) {
        throw new Error("dismissed.json: expected { clearedBefore: number, dismissed: number[] }")
      }
      return { clearedBefore: parsed.clearedBefore, dismissed: parsed.dismissed as number[] }
    } catch (error) {
      if (isNotFound(error)) return { clearedBefore: 0, dismissed: [] }
      throw error
    }
  }

  readAlerts(limit: number): AlertRecord[] {
    const { clearedBefore, dismissed } = this.readDismissed()
    return this.readAlertHistory(Infinity)
      .filter((alert) => alert.at > clearedBefore && !dismissed.includes(alert.at))
      .slice(-limit)
  }

  /** История событий не зависит от скрытия карточек в приложении и состояния доставки каналов. */
  readAlertHistory(limit: number): AlertRecord[] {
    return readLines(join(this.dir, "alerts.jsonl"))
      .map((line) => JSON.parse(line) as AlertRecord)
      .filter((alert) => alert.accountingVersion === ACCOUNTING_VERSION)
      .slice(-limit)
  }

  log(message: string): void {
    appendFileSync(join(this.dir, "plugin.log"), `${new Date().toISOString()} ${message}\n`)
  }

  prune(nowMs: number): void {
    for (const [name, maxAge] of Object.entries(MAX_AGE_MS)) {
      const dir = join(this.dir, name)
      for (const file of readdirSync(dir)) {
        const path = join(dir, file)
        if (nowMs - statSync(path).mtimeMs > maxAge) unlinkSync(path)
      }
    }
  }

  private runningFile(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`unexpected session id: ${id}`)
    return join(this.dir, "running", `${id}.json`)
  }

  private sessionFile(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`unexpected session id: ${id}`)
    return join(this.dir, "sessions", `${id}.json`)
  }
}
