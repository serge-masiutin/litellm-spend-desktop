import { integer, object, parseUpdates, text, type Update } from "./contract.ts"

export interface Panel {
  text: string
  parseMode?: "HTML"
  navigation?: { index: number; count: number }
}
export const BOT_KEYBOARD = {
  keyboard: [[{ text: "Статус" }, { text: "Сессия" }, { text: "Алерты" }]],
  is_persistent: true,
  resize_keyboard: true,
  one_time_keyboard: false,
} as const
export type TelegramTransport = (url: string, init: RequestInit) => Promise<Response>
type Method = "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage" | "editMessageReplyMarkup" | "answerCallbackQuery" | "setMyCommands" | "setChatMenuButton"

/** Только безопасные диагностические поля. URL, token, сырой ответ и сетевые exceptions не логируются. */
export class TelegramError extends Error {
  constructor(readonly code: number, readonly retryAfter: number, readonly transient: boolean, readonly unchanged = false) {
    super(`Telegram API: ${code === 0 ? "network failure / unknown outcome" : `error ${code}`}`)
  }
}

export class TelegramApi {
  private nextMessageAt = 0
  constructor(private readonly token: string, private readonly transport: TelegramTransport = fetch) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("invalid Telegram token format")
  }

  async call(method: Method, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000)
    let response: Response
    try {
      response = await this.transport(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch {
      // Оригинальный fetch exception может содержать token в URL: наружу выходит только безопасная ошибка.
      throw new TelegramError(0, 5, true)
    }
    if (response.status >= 500) throw new TelegramError(response.status, 5, true)
    let raw: unknown
    try { raw = await response.json() } catch { throw new TelegramError(response.status, 0, false) }
    const envelope = object(raw, "Telegram response")
    if (envelope.ok === false) {
      const code = integer(envelope.error_code, "error_code", 1)
      const params = envelope.parameters === undefined ? undefined : object(envelope.parameters, "parameters")
      const retryAfter = params?.retry_after === undefined ? 0 : integer(params.retry_after, "retry_after", 1)
      throw new TelegramError(code, retryAfter, code === 429 || code >= 500, code === 400 && typeof envelope.description === "string" && envelope.description.startsWith("Bad Request: message is not modified"))
    }
    if (!response.ok || envelope.ok !== true || !("result" in envelope)) throw new Error("invalid Telegram success response")
    return envelope.result
  }

  async identity(): Promise<{ id: number; username: string }> {
    const me = object(await this.call("getMe", {}), "getMe")
    if (me.is_bot !== true) throw new Error("getMe: expected bot")
    return { id: integer(me.id, "bot id", 1), username: text(me.username, "bot username") }
  }

  async assertPolling(): Promise<void> {
    const info = object(await this.call("getWebhookInfo", {}), "getWebhookInfo")
    if (typeof info.url !== "string") throw new Error("getWebhookInfo: missing url")
    if (info.url !== "") throw new Error("Bot has a webhook. Use a separate bot; webhook was not changed.")
  }

  async updates(offset: number, signal?: AbortSignal): Promise<Update[]> {
    return parseUpdates(await this.call("getUpdates", { offset, timeout: 5, allowed_updates: ["message", "callback_query"] }, signal))
  }

  async panel(chatId: number, panel: Panel, messageId?: number, silent = true): Promise<void> {
    // Общая последовательная отправка службой, не больше одного сообщения/редактирования в секунду.
    const wait = this.nextMessageAt - Date.now()
    if (wait > 0) await Bun.sleep(wait)
    this.nextMessageAt = Date.now() + 1100
    if (panel.text.length > 3900) throw new Error("Telegram panel exceeds safe message size")
    if (messageId !== undefined) {
      // Убираем старую inline-навигацию при нажатии, затем выдаём обычный отчёт с постоянной клавиатурой.
      try { await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }) } catch (error) {
        if (!(error instanceof TelegramError) || !error.unchanged) throw error
      }
      await Bun.sleep(1100)
    }
    this.nextMessageAt = Date.now() + 1100
    const navigation: { text: string }[] = []
    if (panel.navigation !== undefined) {
      const { index, count } = panel.navigation
      if (index > 0) navigation.push({ text: `← Сессии ${index}` })
      if (index + 1 < count) navigation.push({ text: `Сессии ${index + 2} →` })
    }
    await this.call("sendMessage", {
      chat_id: chatId, disable_notification: silent, text: panel.text,
      ...(panel.parseMode === undefined ? {} : { parse_mode: panel.parseMode }),
      link_preview_options: { is_disabled: true },
      reply_markup: navigation.length === 0 ? BOT_KEYBOARD : { ...BOT_KEYBOARD, keyboard: [...BOT_KEYBOARD.keyboard, navigation] },
    })
  }

  async answer(id: string): Promise<void> { await this.call("answerCallbackQuery", { callback_query_id: id }) }
}
