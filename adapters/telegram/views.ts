import { join } from "node:path"
import { ModelCatalog } from "../../core/catalog.ts"
import { loadConfigFile, type Config } from "../../core/config.ts"
import { fmtMinutes, formatCachePercent, formatCacheTokens, localBudgetNote, monthlyLines, paceWindow, usd } from "../../core/format.ts"
import { hasBudgetEstimate, utcDayStart, UTC_DAY_MS } from "../../core/daily-budget.ts"
import { expandHome } from "../../core/litellm.ts"
import { Monitor, type KeyView } from "../../core/monitor.ts"
import { forecastKey, nextReset, periodStart } from "../../core/rules.ts"
import { Store, type SessionRecord, type Severity } from "../../core/store.ts"
import { sessionTotals } from "../../core/session-totals.ts"
import type { MonthlyEstimate } from "../../core/monthly.ts"
import type { Panel } from "./api.ts"
import type { TelegramProfile } from "./contract.ts"
import type { Pending } from "./state.ts"

export type Report = "status" | "sessions" | "alerts"
export interface Snapshot { cfg: Config; store: Store; key: KeyView | null; monthly: MonthlyEstimate | null; monthlyError: string | null; sessions: SessionRecord[]; corrupt: number; now: number }

/** Только локальные данные: ключ LiteLLM и запросы к моделям не нужны. */
export async function snapshot(configPath: string, now = Date.now()): Promise<Snapshot> {
  const cfg = loadConfigFile(configPath)
  const store = new Store(expandHome(cfg.storage.dir))
  const catalog = new ModelCatalog(null, join(store.dir, "models.json"), () => cfg.models.refreshMinutes)
  const monitor = new Monitor(configPath, catalog, async () => {}, cfg, store)
  const listed = store.listSessions()
  let monthly: MonthlyEstimate | null = null
  let monthlyError: string | null = null
  try { monthly = monitor.currentMonthlyEstimate(now) } catch (error) {
    store.log(`monthly estimate failed: ${String(error)}`)
    monthlyError = "Не удалось прочитать историю месячного расхода."
  }
  return { cfg, store, key: monitor.currentKeyView(now), monthly, monthlyError, sessions: listed.records.filter((s) => s.model.providerID === cfg.models.providerId), corrupt: listed.corrupt.length, now }
}

function plain(value: string, limit = 80): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  const characters = Array.from(text)
  return characters.length <= limit ? text : characters.slice(0, limit - 1).join("") + "…"
}

/** Лимит учитывает HTML-сущности, чтобы отчёты помещались в сообщение Telegram. */
function e(value: string, limit = 80): string {
  let encoded = ""
  for (const character of plain(value, limit)) {
    const next = character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character
    if (encoded.length + next.length > limit) break
    encoded += next
  }
  return encoded
}

const panel = (text: string): Panel => ({ text, parseMode: "HTML" })

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes === 0) return "только что"
  if (minutes < 60) return `${minutes} мин назад`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ч назад`
  return `${Math.floor(minutes / 1440)} дн назад`
}

function stamp(at: number, profile: TelegramProfile): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: profile.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at)
}

function budget(k: KeyView): string[] {
  const { sample, cfg, nowMs } = k
  if (sample.spend < 0) return [
    "⚠️ <b>Аномалия бюджета LiteLLM</b>",
    `Шлюз сообщил отрицательный расход: <b>${usd(sample.spend)}</b>`,
    `Лимит: ${usd(sample.maxBudget)}`, "",
    "Остаток и прогноз недоступны до корректного показания шлюза.",
  ]
  if (k.budget !== undefined && !hasBudgetEstimate(k.budget)) return [
    e(localBudgetNote(k.budget), 700), "",
    `Лимит: ${usd(sample.maxBudget)}. Локальная сумма, остаток и прогноз пока недоступны: нет шагов с известной ценой. Внесите сверенный итог дня в панели.`,
  ]
  const start = k.budget === undefined ? periodStart(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : utcDayStart(nowMs)
  const reset = k.budget === undefined ? nextReset(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : start + UTC_DAY_MS
  const resetHour = k.budget === undefined ? cfg.keyBudget.resetHourUtc : 0
  const lines = [
    `Потрачено <b>${usd(sample.spend)}</b> из ${usd(sample.maxBudget)}`,
    `Осталось <b>${usd(sample.maxBudget - sample.spend)}</b>`, "",
    `Сброс через <b>${fmtMinutes((reset - nowMs) / 60000)}</b> · ${String(resetHour).padStart(2, "0")}:00 UTC`,
  ]
  if (k.budget !== undefined) lines.unshift(e(localBudgetNote(k.budget), 700), "")
  const forecast = forecastKey(k.samples, nowMs, start, sample.maxBudget, cfg.forecast)
  if (forecast !== null) {
    // Темп считается на момент открытия отчёта: пауза после последнего ответа снижает его.
    const projectedLeft = sample.maxBudget - forecast.spend - forecast.ratePerHour * (reset - nowMs) / 3600000
    const idle = k.budget?.source === "manual" ? "После поправки новых учтённых расходов нет" : `За ${paceWindow(cfg.forecast.windowMinutes)} расхода нет`
    const observation = k.budget?.source === "manual" ? "по новым шагам после поправки" : `за ${paceWindow(cfg.forecast.windowMinutes)}`
    lines.push(
      "",
      forecast.ratePerHour === 0 ? idle : `Темп ${observation} ≈ <b>${usd(forecast.ratePerHour)}/ч</b>`,
      projectedLeft >= 0 ? `К сбросу останется ≈ <b>${usd(projectedLeft)}</b>` : `До сброса не хватит · дефицит ≈ <b>${usd(-projectedLeft)}</b>`,
    )
  }
  return lines
}

function sessionLines(s: SessionRecord, snap: Snapshot, totals: Map<string, { cost: number; descendants: number }>): string {
  const cached = s.contextTokens === 0 ? "нет входных данных" : [
    ...(s.lastStepTokens === undefined ? [] : [formatCacheTokens(s.lastStepTokens.cache.read)]),
    formatCachePercent(s.cacheReadRatio),
  ].join(" · ")
  const model = e(`${s.model.id}${s.model.variant === undefined || s.model.variant === "default" ? "" : ` · ${s.model.variant}`}`, 65)
  const when = snap.store.activity(s.id, snap.now) === "running" ? "выполняется" : ago(s.lastStepAt, snap.now)
  const total = totals.get(s.id)!
  return [
    `🔹 <b>${e(s.title || s.id)}</b>`,
    `<i>${model} · ${when}</i>`,
    `Сессия ≈ <b>${usd(s.cost)}</b> · последний шаг ≈ ${usd(s.lastStepCost)}`,
    ...(total.descendants === 0 ? [] : [`С известными сабагентами (${total.descendants}) ≈ <b>${usd(total.cost)}</b>`]),
    `Контекст ${formatCacheTokens(s.contextTokens)} · из кеша ${e(cached, 60)}`,
  ].join("\n")
}

export function render(report: Report, snap: Snapshot, profile: TelegramProfile, requestedPage = 0): Panel {
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 0) throw new Error("invalid session page")
  if (report === "alerts") {
    const alerts = snap.store.readAlerts(Infinity).filter((a) => a.severity === "critical").sort((a, b) => b.at - a.at).slice(0, 10)
    return panel(["🔴 <b>Последние алерты</b>", "", alerts.length === 0 ? "Критических алертов нет." : alerts.map((a) => alertText(a, profile, a.severity, alerts.length > 4)).join("\n\n")].join("\n"))
  }
  const active = snap.sessions.filter((s) => snap.store.activity(s.id, snap.now) === "running").sort((a, b) => b.lastStepAt - a.lastStepAt)
  if (report === "status") {
    const lines = ["💳 <b>Статус LiteLLM</b>", "", ...(snap.key === null ? ["Данных ключа за текущий период пока нет."] : budget(snap.key)), "", `Выполняются сессии: <b>${active.length}</b>`]
    if (snap.cfg.planningBudget !== undefined) {
      lines.push("", ...(snap.monthlyError === null ? monthlyLines(snap.cfg.planningBudget, snap.monthly, snap.key === null ? null : snap.key.sample.maxBudget, snap.now).map((line) => e(line, 600)) : [snap.monthlyError]))
    }
    if (snap.corrupt > 0) lines.push(`Не прочитаны записи сессий: ${snap.corrupt}`)
    return panel(lines.join("\n"))
  }
  const recent = snap.sessions.filter((s) => snap.store.activity(s.id, snap.now) !== "running" && s.cost >= .01).sort((a, b) => b.lastStepAt - a.lastStepAt).slice(0, 4)
  return sessionPage(active, recent, snap, requestedPage)
}

/** Делим только между сессиями; повторяем заголовок группы и не теряем ни одной текущей записи. */
function sessionPage(active: SessionRecord[], recent: SessionRecord[], snap: Snapshot, requestedPage: number): Panel {
  const header = "▶️ <b>Сессии LiteLLM</b>"
  const pages: string[] = []
  const totals = sessionTotals(snap.sessions)
  let text = header + (active.length === 0 ? "\n\nСейчас нет активных сессий." : "")
  const sections = [
    { heading: `🟢 <b>Текущие · ${active.length}</b>`, records: active },
    { heading: `🕓 <b>Недавние · ${recent.length}</b>`, records: recent },
  ]
  for (const section of sections) {
    let first = true
    for (const session of section.records) {
      const entry = sessionLines(session, snap, totals)
      const candidate = `${first ? section.heading + "\n\n" : ""}${entry}`
      // Запас до ограничения API оставлен для номера страницы, пояснения и диагностики.
      if (text.length + candidate.length + 2 > 3500) {
        pages.push(text)
        text = `${header}\n\n${section.heading}${first ? "" : " · продолжение"}\n\n${entry}`
      } else text += `\n\n${candidate}`
      first = false
    }
  }
  pages.push(text)
  const index = Math.min(requestedPage, pages.length - 1)
  const footer = [
    ...(active.length + recent.length === 0 ? [] : ["<i>Оценки за время наблюдения. Суммы с сабагентами включают их собственные расходы; повторно их не складывайте. Старые связи могут быть неизвестны.</i>"]),
    ...(snap.corrupt === 0 ? [] : [`Не прочитаны записи сессий: ${snap.corrupt}`]),
    ...(pages.length === 1 ? [] : [`Страница ${index + 1}/${pages.length}`]),
  ]
  return { ...panel(pages[index] + (footer.length === 0 ? "" : "\n\n" + footer.join("\n"))), ...(pages.length === 1 ? {} : { navigation: { index, count: pages.length } }) }
}

/** При большом списке сокращаем записи так, чтобы десять алертов поместились в одно сообщение. */
export function alertText(a: { at: number; title: string; subtitle?: string; body: string }, profile: TelegramProfile, severity: Severity, compact = false): string {
  const body = plain(a.body, 700).split(/(?<=[.!?])\s+(?=[А-ЯЁ])/u).slice(0, 2).join(" ")
  const icon = severity === "critical" ? "🔴" : severity === "warn" ? "⚠️" : "ℹ️"
  return [
    `${icon} <b>${e(a.title, compact ? 100 : 120)}</b>`,
    ...(a.subtitle === undefined ? [] : [e(a.subtitle, compact ? 60 : 80)]),
    e(body, compact ? 160 : 300),
    `<i>${stamp(a.at, profile)}</i>`,
  ].join("\n")
}

export function alertDigest(alerts: Pending[], profile: TelegramProfile): string {
  return [
    `⚠️ <b>Пропущенные критические алерты: ${alerts.length}</b>`, "",
    alerts.map((a) => `🔴 <b>${e(a.title, 100)}</b>${a.subtitle === undefined ? "" : `\n${e(a.subtitle)}`}\n<i>${stamp(a.at, profile)}</i>`).join("\n\n"),
  ].join("\n")
}
