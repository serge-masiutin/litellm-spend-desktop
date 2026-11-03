import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { TelegramApi, TelegramError, type Panel, type TelegramTransport } from "./api.ts"
import { authorized, type TelegramProfile, type Update } from "./contract.ts"
import { collectAlerts, parseState, readJson, saveJson, acquireProcessLock, type DeliveryState } from "./state.ts"
import { alertDigest, alertText, render, snapshot, type Report, type Snapshot } from "./views.ts"

export const COMMANDS = [
  ["status", "Статус"], ["session", "Сессия"], ["alerts", "Алерты"],
].map(([command, description]) => ({ command, description }))
type Bot = Pick<TelegramApi, "panel" | "answer">

export async function handleUpdate(update: Update, profile: TelegramProfile, snap: Snapshot, api: Bot): Promise<void> {
  if (!authorized(update, profile.owner)) return
  let report: Report = "status"
  let page = 0
  let messageId: number | undefined
  if (update.callback !== undefined) {
    const callback = update.callback
    try { await api.answer(callback.id) } catch (error) {
      // Просроченная callback query не мешает безопасно обновить личную панель.
      if (!(error instanceof TelegramError) || error.code !== 400) throw error
    }
    messageId = callback.messageId
    // Старые кнопки больше не меняют настройки и не открывают вложенные меню.
    report = callback.data.startsWith("v:alerts:") ? "alerts" : callback.data.startsWith("v:sessions:") || callback.data.startsWith("s:") ? "sessions" : "status"
  } else if (update.command !== undefined) {
    if (snap.now - update.command.at > 5 * 60_000) {
      await api.panel(profile.owner.chatId, { text: "Команда получена с задержкой более 5 минут. Нажмите «Статус», «Сессия» или «Алерты» для свежих данных." })
      return
    }
    const input = update.command.text.trim().toLowerCase()
    const sessionPage = /^(?:← )?сессии ([1-9]\d{0,5})(?: →)?$/.exec(input)
    if (input === "алерты" || /^\/alerts(?:@[a-z0-9_]+)?$/.test(input)) report = "alerts"
    else if (sessionPage !== null) { report = "sessions"; page = Number(sessionPage[1]) - 1 }
    else if (input === "сессия" || /^\/sessions?(?:@[a-z0-9_]+)?$/.test(input)) report = "sessions"
    else if (input !== "статус" && !/^\/(?:start|status)(?:@[a-z0-9_]+)?$/.test(input)) {
      await api.panel(profile.owner.chatId, { text: "Выберите «Статус», «Сессия» или «Алерты»." })
      return
    }
  } else return
  await api.panel(profile.owner.chatId, render(report, snap, profile, page), messageId)
}

export async function deliver(state: DeliveryState, profile: TelegramProfile, api: Pick<TelegramApi, "panel">, save: () => void, now = Date.now()): Promise<void> {
  if (!state.enabled || state.pending.length === 0 || state.retryAt > now || state.failures >= 8) return
  const count = state.pending.length > 5 || now - state.pending[0].at > 60 * 60_000 ? Math.min(5, state.pending.length) : 1
  const batch = state.pending.slice(0, count)
  const panel: Panel = {
    text: count > 1 ? alertDigest(batch, profile) : alertText(batch[0], profile, "critical"),
    parseMode: "HTML",
  }
  try {
    await api.panel(profile.owner.chatId, panel, undefined, false)
    state.pending.splice(0, count)
    state.failures = 0
    state.retryAt = 0
    state.lastError = null
    save()
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error
    state.failures++
    state.lastError = error.message
    state.retryAt = now + Math.max(error.retryAfter * 1000, Math.min(300_000, 5000 * 2 ** state.failures))
    if (!error.transient) state.failures = 8
    save()
    if (error.code === 401 || error.code === 403 || error.code === 409) throw error
  }
}

export async function runTelegram(configPath: string, profile: TelegramProfile, dir: string, signal: AbortSignal, transport: TelegramTransport = fetch): Promise<void> {
  const files = join(dir, "telegram")
  const release = acquireProcessLock(files)
  try {
    const stateFile = join(files, "state.json")
    const state = parseState(readJson(stateFile), profile)
    const save = () => saveJson(stateFile, state)
    const api = new TelegramApi(readFileSync(profile.tokenFile, "utf8").trim(), transport)
    try {
      const me = await api.identity()
      if (me.id !== profile.botId) throw new Error("Telegram token belongs to another bot: run setup")
      await api.assertPolling()
      const scope = { type: "chat", chat_id: profile.owner.chatId }
      await api.call("setMyCommands", { commands: COMMANDS, scope })
      await api.call("setMyCommands", { commands: COMMANDS, scope, language_code: "ru" })
      await api.call("setChatMenuButton", { chat_id: profile.owner.chatId, menu_button: { type: "commands" } })
    } catch (error) {
      state.lastError = error instanceof TelegramError ? error.message : "Ошибка привязки Telegram; проверьте локальный service.log"
      save()
      throw error
    }
    let pollFailures = 0
    while (!signal.aborted) {
      const retryRequest = join(files, "retry-request")
      if (existsSync(retryRequest)) {
        state.failures = 0
        state.retryAt = 0
        state.lastError = null
        save()
        unlinkSync(retryRequest)
      }
      const snap = await snapshot(configPath)
      if (snap.store.dir !== dir) throw new Error("storage.dir changed: restart Telegram with the new storage")
      const paused = snap.store.notificationsPaused()
      collectAlerts(dir, state, paused)
      if (paused || !state.enabled) state.pending = []
      save()
      await deliver(state, profile, api, save)
      try {
        const updates = await api.updates(state.updateOffset, signal)
        for (const update of updates) {
          if (update.id < state.updateOffset) continue
          await handleUpdate(update, profile, await snapshot(configPath), api)
          state.updateOffset = update.id + 1
          save()
        }
        pollFailures = 0
        state.lastPollAt = Date.now()
        save()
      } catch (error) {
        if (signal.aborted) break
        if (!(error instanceof TelegramError)) throw error
        state.lastError = error.message
        save()
        if (!error.transient || error.code === 409) throw error
        pollFailures++
        snap.store.log(`telegram poll: ${error.message}`)
        await Bun.sleep(Math.max(error.retryAfter * 1000, Math.min(30_000, 1000 * 2 ** Math.min(pollFailures, 5))))
      }
    }
  } finally { release() }
}
