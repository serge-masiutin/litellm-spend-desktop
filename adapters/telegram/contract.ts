/** Декодеры границ Telegram и его локальных файлов. Неизвестные поля API допускаются. */
export function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path}: expected object`)
  return value as Record<string, unknown>
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}: expected non-empty string`)
  return value
}

export function number(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${path}: invalid number`)
  return value
}

export function integer(value: unknown, path: string, min = 0): number {
  const result = number(value, path, min)
  if (!Number.isSafeInteger(result)) throw new Error(`${path}: expected safe integer`)
  return result
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`)
  return value
}

export interface Owner { userId: number; chatId: number }
export interface TelegramProfile {
  version: 1
  botId: number
  owner: Owner
  deviceName: string
  timeZone: string
  tokenFile: string
}

export function parseOwner(raw: unknown): Owner {
  const o = object(raw, "owner")
  return { userId: integer(o.userId, "userId", 1), chatId: integer(o.chatId, "chatId", 1) }
}

export function parseProfile(raw: unknown): TelegramProfile {
  const p = object(raw, "telegram profile")
  if (p.version !== 1) throw new Error("unsupported Telegram profile version")
  const timeZone = text(p.timeZone, "timeZone")
  new Intl.DateTimeFormat("ru-RU", { timeZone })
  return { version: 1, botId: integer(p.botId, "botId", 1), owner: parseOwner(p.owner), deviceName: text(p.deviceName, "deviceName"), timeZone, tokenFile: text(p.tokenFile, "tokenFile") }
}

export interface Update {
  id: number
  actor?: { userId: number; chatId: number; private: boolean }
  command?: { text: string; at: number }
  callback?: { id: string; data: string; messageId: number }
}

/** Прочие виды сообщений, вложения и служебные updates не дают команд и лишь подтверждаются. */
export function parseUpdates(raw: unknown): Update[] {
  if (!Array.isArray(raw)) throw new Error("getUpdates: expected array")
  return raw.map((value) => {
    const u = object(value, "update")
    const update: Update = { id: integer(u.update_id, "update_id") }
    if (u.callback_query !== undefined) {
      const q = object(u.callback_query, "callback_query")
      if (q.message === undefined || q.data === undefined) return update
      const m = object(q.message, "callback.message")
      const chat = object(m.chat, "chat")
      const from = object(q.from, "from")
      update.actor = { userId: integer(from.id, "user id", 1), chatId: integer(chat.id, "chat id", -Number.MAX_SAFE_INTEGER), private: chat.type === "private" }
      update.callback = { id: text(q.id, "callback id"), data: text(q.data, "callback data"), messageId: integer(m.message_id, "message id", 1) }
    } else if (u.message !== undefined) {
      const m = object(u.message, "message")
      if (m.text === undefined || m.from === undefined) return update
      const chat = object(m.chat, "chat")
      const from = object(m.from, "from")
      update.actor = { userId: integer(from.id, "user id", 1), chatId: integer(chat.id, "chat id", -Number.MAX_SAFE_INTEGER), private: chat.type === "private" }
      update.command = { text: text(m.text, "message text"), at: integer(m.date, "message date") * 1000 }
    }
    return update
  })
}

export function authorized(update: Update, owner: Owner): boolean {
  return update.actor !== undefined && update.actor.private && update.actor.userId === owner.userId && update.actor.chatId === owner.chatId
}
