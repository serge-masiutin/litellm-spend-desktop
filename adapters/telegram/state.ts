import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { ACCOUNTING_VERSION } from "../../core/store.ts"
import { boolean, integer, object, text, type TelegramProfile } from "./contract.ts"

export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")) }
export function saveJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}
export function journalSize(dir: string): number {
  try { return statSync(join(dir, "alerts.jsonl")).size } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw e
  }
}

export interface Pending { id: string; at: number; title: string; subtitle?: string; body: string }
export interface DeliveryState {
  version: 1
  botId: number
  chatId: number
  userId: number
  offset: number
  updateOffset: number
  enabled: boolean
  pending: Pending[]
  failures: number
  retryAt: number
  lastError: string | null
  lastPollAt: number
}

export function initialState(dir: string, profile: TelegramProfile): DeliveryState {
  return { version: 1, botId: profile.botId, ...profile.owner, offset: journalSize(dir), updateOffset: 0, enabled: true, pending: [], failures: 0, retryAt: 0, lastError: null, lastPollAt: 0 }
}

function parsePending(raw: unknown): Pending {
  const p = object(raw, "pending alert")
  return { id: text(p.id, "alert id"), at: integer(p.at, "alert time"), title: text(p.title, "alert title"), body: text(p.body, "alert body"), ...(p.subtitle === undefined ? {} : { subtitle: text(p.subtitle, "alert subtitle") }) }
}

export function parseState(raw: unknown, profile: TelegramProfile): DeliveryState {
  const s = object(raw, "Telegram state")
  if (s.version !== 1 || s.botId !== profile.botId || s.userId !== profile.owner.userId || s.chatId !== profile.owner.chatId) throw new Error("Telegram state identity/version mismatch: run setup locally")
  if (!Array.isArray(s.pending) || s.pending.length > 1000) throw new Error("invalid Telegram pending queue")
  return {
    version: 1, botId: profile.botId, ...profile.owner, offset: integer(s.offset, "journal offset"), updateOffset: integer(s.updateOffset, "update offset"),
    enabled: boolean(s.enabled, "enabled"), pending: s.pending.map(parsePending), failures: integer(s.failures, "failures"), retryAt: integer(s.retryAt, "retryAt"),
    lastError: s.lastError === null ? null : text(s.lastError, "lastError"), lastPollAt: integer(s.lastPollAt, "lastPollAt"),
  }
}

/** ОС освобождает блокировку после аварии. SQLite встроен в Bun; хранилище мониторинга не мигрируется. */
export function acquireProcessLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, "process-lock.sqlite")
  const db = new Database(file, { create: true })
  chmodSync(file, 0o600)
  try { db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE") } catch (cause) {
    db.close(true)
    throw new Error("Telegram process is already running for this storage", { cause })
  }
  return () => { db.exec("ROLLBACK"); db.close(true) }
}

/** Читаем только завершённые строки; курсор и очередь сохраняются одной атомарной заменой файла. */
export function collectAlerts(dir: string, state: DeliveryState, paused: boolean): void {
  const size = journalSize(dir)
  if (state.offset > size) throw new Error("Alert journal was truncated: delivery offset requires local recovery")
  if (size === state.offset) return
  const fd = openSync(join(dir, "alerts.jsonl"), "r")
  const buffer = Buffer.alloc(Math.min(size - state.offset, 1024 * 1024))
  let count: number
  try { count = readSync(fd, buffer, 0, buffer.length, state.offset) } finally { closeSync(fd) }
  const end = buffer.subarray(0, count).lastIndexOf(10)
  if (end < 0) {
    if (count === buffer.length && size - state.offset > buffer.length) throw new Error("Alert journal line exceeds limit")
    return
  }
  for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
    const raw = object(JSON.parse(line), "alert journal")
    if (raw.accountingVersion !== ACCOUNTING_VERSION || raw.severity !== "critical" || raw.id === undefined || raw.notificationsSuppressed === true) continue
    const alert = parsePending(raw)
    if (state.enabled && !paused && !state.pending.some((p) => p.id === alert.id)) state.pending.push(alert)
    if (state.pending.length > 1000) throw new Error("Telegram pending queue exceeded 1000 alerts; delivery needs attention")
  }
  state.offset += end + 1
  if (!state.enabled || paused) state.pending = []
}
