import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir, hostname } from "node:os"
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import { execFileSync } from "node:child_process"
import { loadConfigFile } from "../../core/config.ts"
import { expandHome } from "../../core/litellm.ts"
import { TelegramApi } from "./api.ts"
import { parseProfile, type TelegramProfile } from "./contract.ts"
import { acquireProcessLock, initialState, parseState, readJson, saveJson } from "./state.ts"
import { runTelegram } from "./service.ts"

const LABEL = "local.litellm-spend.telegram"
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export function servicePlist(executable: string, entry: string, config: string, log: string): string {
  const args = [executable, entry, "telegram", "run", "--config", config]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`
}

export function readToken(path: string): string {
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) throw new Error("Telegram token file must be accessible only to its owner (chmod 600)")
  return readFileSync(path, "utf8").trim()
}

async function setup(dir: string): Promise<"install-service" | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Telegram setup requires an interactive local terminal. Do not pass tokens in command arguments.")
  const release = acquireProcessLock(dir)
  let hidden = false
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback() } })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  rl.on("SIGINT", () => rl.close())
  try {
    if (existsSync(join(dir, "profile.json"))) {
      if ((await rl.question("Уже есть привязка. Заменить владельца и очередь? Напишите да: ")).trim().toLowerCase() !== "да") return
    }
    console.log("Создайте личного бота через @BotFather. Токен вводится только здесь и не отображается.")
    process.stdout.write("Токен бота: ")
    hidden = true
    let token: string
    try { token = (await rl.question("")).trim() } finally { hidden = false; process.stdout.write("\n") }
    const api = new TelegramApi(token)
    const me = await api.identity()
    await api.assertPolling()
    const deviceName = (await rl.question(`Название компьютера [${hostname()}]: `)).trim() || hostname()
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timeZone = (await rl.question(`Часовой пояс отображения [${localZone}]: `)).trim() || localZone
    new Intl.DateTimeFormat("ru-RU", { timeZone })
    console.log("В Telegram будут названия сессий, модели, суммы, размер контекста и кеша. Промпты, файлы, пути и ключи не отправляются.")
    if ((await rl.question("Подключить эти данные и только критические автоуведомления? [да/нет]: ")).trim().toLowerCase() !== "да") return
    const code = randomBytes(24).toString("base64url")
    console.log(`Откройте в своём Telegram и нажмите Start (ссылка действует 5 минут):\nhttps://t.me/${me.username}?start=${code}`)
    const deadline = Date.now() + 5 * 60_000
    let offset = 0
    let profile: TelegramProfile | undefined
    while (Date.now() < deadline && profile === undefined) {
      for (const update of await api.updates(offset)) {
        offset = Math.max(offset, update.id + 1)
        if (update.command?.text !== `/start ${code}` || update.actor === undefined || !update.actor.private || update.actor.chatId < 1 || Date.now() > deadline) continue
        console.log(`Запрос привязки: user_id ${update.actor.userId}, chat_id ${update.actor.chatId}.`)
        if ((await rl.question("Это ваш аккаунт? Подтвердите на компьютере словом да: ")).trim().toLowerCase() !== "да") continue
        if (Date.now() > deadline) throw new Error("Pairing link expired. Run setup again.")
        profile = { version: 1, botId: me.id, owner: { userId: update.actor.userId, chatId: update.actor.chatId }, deviceName, timeZone, tokenFile: join(dir, "token") }
        break
      }
    }
    if (profile === undefined) throw new Error("Telegram pairing expired; no reports were disclosed")
    writeFileSync(profile.tokenFile, token, { mode: 0o600 })
    chmodSync(profile.tokenFile, 0o600)
    saveJson(join(dir, "profile.json"), profile)
    const state = initialState(dirname(dir), profile)
    state.updateOffset = offset
    saveJson(join(dir, "state.json"), state)
    console.log("Привязка сохранена. Старая история не рассылается.")
    if ((await rl.question("Отправить тестовое сообщение Telegram сейчас? [да/нет]: ")).trim().toLowerCase() === "да") {
      await api.panel(profile.owner.chatId, { text: "Тест LiteLLM Spend\nTelegram подключён. Это проверка доставки, не реальная тревога. Запросов к моделям не было." }, undefined, false)
      console.log("Тестовое сообщение принято Telegram.")
    }
    if (process.platform === "darwin" && (await rl.question("Запустить Telegram в фоне и включить автозапуск при входе в macOS? [да/нет]: ")).trim().toLowerCase() === "да") return "install-service"
    console.log("Для ручного запуска: telegram run. Для автозапуска macOS: telegram install-service.")
  } finally { rl.close(); release() }
}

export async function telegramCli(configPath: string, action: string): Promise<void> {
  const cfg = loadConfigFile(configPath)
  const storage = resolve(expandHome(cfg.storage.dir))
  const dir = join(storage, "telegram")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (action === "setup") {
    const next = await setup(dir)
    if (next !== undefined) await telegramCli(configPath, next)
    return
  }
  if (action === "pause-all" || action === "resume-all") {
    const file = join(storage, "notifications-off")
    if (action === "pause-all") writeFileSync(file, "Все каналы уведомлений приостановлены локально\n", { mode: 0o600 })
    else if (existsSync(file)) unlinkSync(file)
    console.log(action === "pause-all" ? "Все каналы уведомлений приостановлены. Отчёты по запросу доступны." : "Каналы уведомлений возобновлены. Пропущенные в паузе события не рассылаются.")
    return
  }
  if (!["run", "status", "test", "retry", "install-service", "uninstall-service"].includes(action)) {
    if (action !== "help") throw new Error("Unknown Telegram action; run telegram help")
    console.log("usage: litellm-spend telegram <setup|run|status|test|retry|install-service|uninstall-service|pause-all|resume-all> [--config path]")
    return
  }
  if (action === "uninstall-service") {
    if (process.platform !== "darwin") throw new Error("LaunchAgent is available only on macOS")
    const file = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
    execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid!()}`, file], { stdio: "pipe" })
    unlinkSync(file)
    console.log("Автозапуск Telegram удалён; токен и привязка сохранены локально.")
    return
  }
  const profileFile = join(dir, "profile.json")
  if (!existsSync(profileFile)) throw new Error("Telegram is not connected. Run telegram setup in a local terminal.")
  const profile = parseProfile(readJson(profileFile))
  if (action === "retry") {
    writeFileSync(join(dir, "retry-request"), "retry\n", { mode: 0o600 })
    console.log("Повтор доставки запрошен. Работающий Telegram-процесс обработает его без очистки очереди.")
    return
  }
  if (action === "status") {
    const state = parseState(readJson(join(dir, "state.json")), profile)
    console.log(JSON.stringify({ device: profile.deviceName, notifications: state.enabled ? "critical" : "off", pending: state.pending.length, lastPollAt: state.lastPollAt === 0 ? null : new Date(state.lastPollAt).toISOString(), recentPolling: state.lastPollAt > Date.now() - 60_000, lastError: state.lastError, deliveryBlocked: state.failures >= 8 }, null, 2))
    return
  }
  if (action === "test") {
    const api = new TelegramApi(readToken(profile.tokenFile))
    if ((await api.identity()).id !== profile.botId) throw new Error("Token belongs to another bot")
    await api.panel(profile.owner.chatId, { text: "Тест LiteLLM Spend\nTelegram подключён. Это тестовое сообщение, не реальная тревога. Запросов к моделям не было." }, undefined, false)
    console.log("Тестовое сообщение принято Telegram.")
    return
  }
  if (action === "install-service") {
    if (process.platform !== "darwin") throw new Error("LaunchAgent is available only on macOS; use telegram run with your service manager")
    const directory = join(homedir(), "Library/LaunchAgents")
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${LABEL}.plist`)
    if (existsSync(file)) throw new Error("LaunchAgent already exists. Use uninstall-service before reinstalling.")
    const log = join(dir, "service.log")
    writeFileSync(log, "", { flag: "a", mode: 0o600 })
    chmodSync(log, 0o600)
    // argv[1] — реальная точка входа и у исходников, и у JS, упакованного внутрь .app.
    writeFileSync(file, servicePlist(process.execPath, resolve(process.argv[1]), resolve(configPath), log), { mode: 0o600 })
    execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, file], { stdio: "pipe" })
    console.log("Фоновый процесс Telegram установлен и запущен. Проверка: telegram status.")
    return
  }
  readToken(profile.tokenFile)
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try { await runTelegram(configPath, profile, storage, abort.signal) } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}
