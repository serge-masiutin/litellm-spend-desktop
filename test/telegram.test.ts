import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BOT_KEYBOARD, TelegramApi, TelegramError, type TelegramTransport } from "../adapters/telegram/api.ts"
import { authorized, parseProfile, parseUpdates, type TelegramProfile, type Update } from "../adapters/telegram/contract.ts"
import { acquireProcessLock, collectAlerts, initialState, parseState, readJson, saveJson } from "../adapters/telegram/state.ts"
import { COMMANDS, deliver, handleUpdate, runTelegram } from "../adapters/telegram/service.ts"
import { render, snapshot } from "../adapters/telegram/views.ts"
import { formatCachePercent, formatCacheTokens } from "../core/format.ts"
import { readToken, servicePlist, telegramCli } from "../adapters/telegram/cli.ts"
import { ModelCatalog } from "../core/catalog.ts"
import { Monitor } from "../core/monitor.ts"
import { parseConfig } from "../core/config.ts"
import { ACCOUNTING_VERSION, Store } from "../core/store.ts"
import defaults from "../config.defaults.json"
import { periodStart } from "../core/rules.ts"

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "telegram-spend-")); dirs.push(dir)
  const raw = structuredClone(defaults)
  raw.storage.dir = dir
  const config = join(dir, "config.json")
  writeFileSync(config, JSON.stringify(raw))
  const profile: TelegramProfile = { version: 1, botId: 123, owner: { userId: 42, chatId: 42 }, deviceName: "Ноутбук", timeZone: "UTC", tokenFile: join(dir, "token") }
  const store = new Store(dir)
  const state = initialState(dir, profile)
  return { dir, config, raw, profile, store, state }
}
const alert = (id: string, severity: "critical" | "warn" = "critical") => ({ id, at: Date.now(), title: "Дорогой контекст", subtitle: "Моя сессия", body: "Кеш 869k, вход $1.74", severity, accountingVersion: ACCOUNTING_VERSION })
const fakeToken = "123456:abcdefghijklmnopqrstuv"
const transport = (reply: unknown, status = 200): TelegramTransport => async () => Response.json(reply, { status })
const update = (body = "/status"): Update => ({ id: 1, actor: { userId: 42, chatId: 42, private: true }, command: { text: body, at: Date.now() } })

describe("Telegram protocol and access", () => {
  test("validates identity, time zone, required fields and update payloads", () => {
    const f = fixture()
    expect(parseProfile(f.profile)).toEqual(f.profile)
    expect(() => parseProfile({ ...f.profile, timeZone: "Not/AZone" })).toThrow()
    expect(() => parseProfile({ ...f.profile, owner: { userId: "42", chatId: 42 } })).toThrow()
    expect(() => parseUpdates([{ update_id: 1, message: { text: "/status", from: { id: "bad" }, chat: { id: 42, type: "private" }, date: 1 } }])).toThrow()
    expect(parseUpdates([{ update_id: 3, message: { document: {} } }])).toEqual([{ id: 3 }])
  })
  test("authorizes user AND private chat, including callback buttons", () => {
    const f = fixture()
    expect(authorized(update(), f.profile.owner)).toBe(true)
    for (const actor of [{ userId: 7, chatId: 42, private: true }, { userId: 42, chatId: 7, private: true }, { userId: 42, chatId: 42, private: false }]) {
      expect(authorized({ ...update(), actor }, f.profile.owner)).toBe(false)
    }
    const parsed = parseUpdates([{ update_id: 2, callback_query: { id: "q", from: { id: 42 }, data: "v:context:0", message: { message_id: 1, chat: { id: 42, type: "private" } } } }])[0]
    expect(authorized(parsed, f.profile.owner)).toBe(true)
  })
  test("network failures never leak token or URL", async () => {
    const api = new TelegramApi(fakeToken, async (url) => { throw new Error(`failed ${url}`) })
    try { await api.identity(); throw new Error("expected failure") } catch (error) {
      expect(error).toBeInstanceOf(TelegramError)
      expect(String(error)).not.toContain(fakeToken)
      expect((error as Error).stack).not.toContain(fakeToken)
    }
  })
  test("validates API envelope, handles rate limits and never removes webhooks", async () => {
    await expect(new TelegramApi(fakeToken, transport({ ok: true, result: { id: 123, username: "mybot", is_bot: true } })).identity()).resolves.toEqual({ id: 123, username: "mybot" })
    await expect(new TelegramApi(fakeToken, transport({ ok: true, result: { id: "123" } })).identity()).rejects.toThrow()
    await expect(new TelegramApi(fakeToken, transport({ ok: true, result: { url: "https://existing.example" } })).assertPolling()).rejects.toThrow("webhook")
    try { await new TelegramApi(fakeToken, transport({ ok: false, error_code: 429, parameters: { retry_after: 20 } }, 429)).identity() } catch (error) {
      expect((error as TelegramError).retryAfter).toBe(20)
      expect((error as TelegramError).transient).toBe(true)
    }
  })
  test("token file rejects permissions readable by other users", () => {
    const f = fixture()
    writeFileSync(f.profile.tokenFile, fakeToken, { mode: 0o644 })
    expect(() => readToken(f.profile.tokenFile)).toThrow("chmod 600")
  })
})

describe("durable critical delivery", () => {
  test("starts at current end; ignores old history, warning and app dismissal", () => {
    const f = fixture()
    f.store.appendAlert(alert("old"))
    const state = initialState(f.dir, f.profile)
    f.store.appendAlert(alert("warning", "warn"))
    f.store.appendAlert(alert("critical"))
    writeFileSync(join(f.dir, "dismissed.json"), JSON.stringify({ clearedBefore: Date.now() + 100000, dismissed: [] }))
    collectAlerts(f.dir, state, false)
    expect(state.pending.map((a) => a.id)).toEqual(["critical"])
    collectAlerts(f.dir, state, false)
    expect(state.pending).toHaveLength(1)
  })
  test("partial journal line waits; queue and offset survive a restart", () => {
    const f = fixture()
    const line = JSON.stringify(alert("partial"))
    appendFileSync(join(f.dir, "alerts.jsonl"), line.slice(0, 15))
    collectAlerts(f.dir, f.state, false)
    expect(f.state.offset).toBe(0)
    appendFileSync(join(f.dir, "alerts.jsonl"), line.slice(15) + "\n")
    collectAlerts(f.dir, f.state, false)
    const file = join(f.dir, "state.json")
    saveJson(file, f.state)
    const restarted = parseState(readJson(file), f.profile)
    collectAlerts(f.dir, restarted, false)
    expect(restarted.pending.map((p) => p.id)).toEqual(["partial"])
    expect(restarted.offset).toBe(Buffer.byteLength(line + "\n"))
  })
  test("off and master pause do not replay muted alerts later", () => {
    const f = fixture()
    f.store.appendAlert({ ...alert("paused-at-source"), notificationsSuppressed: true })
    collectAlerts(f.dir, f.state, false)
    expect(f.state.pending).toEqual([])
    f.state.enabled = false
    f.store.appendAlert(alert("off"))
    collectAlerts(f.dir, f.state, false)
    f.state.enabled = true
    f.store.appendAlert(alert("paused"))
    collectAlerts(f.dir, f.state, true)
    collectAlerts(f.dir, f.state, false)
    expect(f.state.pending).toEqual([])
  })
  test("transient failure retains event; retry acknowledges only after API success", async () => {
    const f = fixture()
    f.state.pending = [alert("a")]
    let saves = 0
    await deliver(f.state, f.profile, { panel: async () => { throw new TelegramError(429, 20, true) } }, () => saves++)
    expect(f.state.pending).toHaveLength(1)
    expect(f.state.retryAt).toBeGreaterThan(Date.now())
    await deliver(f.state, f.profile, { panel: async () => {} }, () => saves++, f.state.retryAt + 1)
    expect(f.state.pending).toEqual([])
    expect(saves).toBe(2)
  })
  test("permanent failure retains queue and exposes blocked state", async () => {
    const f = fixture()
    f.state.pending = [alert("a")]
    await expect(deliver(f.state, f.profile, { panel: async () => { throw new TelegramError(403, 0, false) } }, () => {})).rejects.toThrow()
    expect(f.state.pending).toHaveLength(1)
    expect(f.state.failures).toBe(8)
  })
  test("backlog digest is bounded even for long escaped titles", async () => {
    const f = fixture()
    f.state.pending = Array.from({ length: 6 }, (_, i) => ({ ...alert(String(i)), title: "<&".repeat(1000), subtitle: "&".repeat(1000), body: "<".repeat(1000) }))
    await deliver(f.state, f.profile, { panel: async (_chat, panel) => { expect(panel.text.length).toBeLessThan(3900) } }, () => {})
    expect(f.state.pending).toHaveLength(1)
  })
  test("OS process lock excludes a second instance and releases cleanly", () => {
    const f = fixture()
    const unlock = acquireProcessLock(f.dir)
    expect(() => acquireProcessLock(f.dir)).toThrow("already running")
    unlock()
    acquireProcessLock(f.dir)()
  })
  test("OS releases the process lock after an actual child-process crash", async () => {
    const f = fixture()
    const module = new URL("../adapters/telegram/state.ts", import.meta.url).pathname
    const code = `import { acquireProcessLock } from ${JSON.stringify(module)}; acquireProcessLock(${JSON.stringify(f.dir)}); console.log('locked'); setInterval(() => {}, 1000)`
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = child.stdout.getReader()
      const first = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(first.value)).toContain("locked")
    } finally { child.kill(9); await child.exited }
    acquireProcessLock(f.dir)()
  })
  test("state cannot be reused with another Telegram account", () => {
    const f = fixture()
    expect(() => parseState(f.state, { ...f.profile, owner: { userId: 7, chatId: 7 } })).toThrow("mismatch")
  })
})

describe("local commands and panels", () => {
  test("daemon routes real protocol through a mocked HTTP boundary, persists offsets and stops cleanly", async () => {
    const f = fixture()
    const files = join(f.dir, "telegram")
    acquireProcessLock(files)()
    writeFileSync(f.profile.tokenFile, fakeToken, { mode: 0o600 })
    f.state.failures = 8
    saveJson(join(files, "state.json"), f.state)
    saveJson(join(files, "profile.json"), f.profile)
    await telegramCli(f.config, "retry")
    f.store.appendAlert(alert("live-critical"))
    const stop = new AbortController()
    const methods: string[] = []
    const messages: string[] = []
    const http: TelegramTransport = async (url, init) => {
      expect(url.startsWith("https://api.telegram.org/")).toBe(true)
      const method = url.split("/").at(-1)!
      methods.push(method)
      const body = JSON.parse(String(init.body))
      let result: unknown = true
      if (method === "getMe") result = { id: 123, username: "mybot", is_bot: true }
      if (method === "getWebhookInfo") result = { url: "" }
      if (method === "getUpdates") result = [
        { update_id: 1, message: { from: { id: 7 }, chat: { id: 7, type: "private" }, text: "/status", date: Math.floor(Date.now() / 1000) } },
        { update_id: 2, message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "Статус", date: Math.floor(Date.now() / 1000) } },
      ]
      if (method === "sendMessage") {
        expect(body.chat_id).toBe(42)
        expect(body.reply_markup).toEqual(BOT_KEYBOARD)
        expect(body.parse_mode).toBe("HTML")
        messages.push(body.text)
        if (messages.length === 2) stop.abort()
        result = { message_id: messages.length }
      }
      return Response.json({ ok: true, result })
    }
    await runTelegram(f.config, f.profile, f.dir, stop.signal, http)
    const saved = parseState(readJson(join(files, "state.json")), f.profile)
    expect(saved.pending).toEqual([])
    expect(saved.updateOffset).toBe(3)
    expect(saved.lastPollAt).toBeGreaterThan(0)
    expect(existsSync(join(files, "retry-request"))).toBe(false)
    expect(messages).toHaveLength(2)
    expect(methods).not.toContain("deleteWebhook")
    acquireProcessLock(files)()
  })
  test("unauthorized commands and forged buttons cannot send or mutate settings", async () => {
    const f = fixture(); const snap = await snapshot(f.config)
    const denied = { ...update(), actor: { userId: 7, chatId: 7, private: true }, callback: { id: "x", data: "notify:off", messageId: 1 } }
    await handleUpdate(denied, f.profile, snap, { panel: async () => { throw new Error("should not send") }, answer: async () => { throw new Error("should not answer") } })
    expect(f.state.enabled).toBe(true)
  })
  test("status renders locally without a LiteLLM API key", async () => {
    const f = fixture(); const snap = await snapshot(f.config)
    let sent = ""
    await handleUpdate(update("/status"), f.profile, snap, { panel: async (_id, panel) => { sent = panel.text }, answer: async () => {} })
    expect(sent).toContain("Статус LiteLLM")
    expect(sent).not.toContain("Задача: оцени")
    expect(sent).not.toContain("/project")
  })
  test("expired commands do not pretend to be fresh", async () => {
    const f = fixture(); const snap = await snapshot(f.config)
    const old = update(); old.command!.at -= 10 * 60000
    let sent = ""
    await handleUpdate(old, f.profile, snap, { panel: async (_id, panel) => { sent = panel.text }, answer: async () => {} })
    expect(sent).toContain("с задержкой")
  })
  test("formatted session names are escaped and foreign provider excluded", async () => {
    const f = fixture()
    const tokens = { input: 1, output: 0, reasoning: 0, cache: { read: 150000, write: 0 } }
    const cfg = parseConfig(f.raw)
    const monitor = new Monitor(f.config, new ModelCatalog(null, join(f.dir, "models.json"), () => 60), async () => {}, cfg, f.store)
    await monitor.onStep({ id: "a", at: Date.now(), sessionId: "s1", sessionTitle: "Моя <сессия> & отчёт", directory: "/secret/path", model: { id: "model" }, tokens, reportedStepCost: .01 })
    f.store.writeSession({ ...f.store.readSession("s1")!, id: "other", title: "FOREIGN", model: { providerID: "openai", id: "x" } })
    const snap = await snapshot(f.config)
    for (const view of ["status", "sessions", "alerts"] as const) {
      const panel = render(view, snap, f.profile)
      expect(panel.text.length).toBeLessThan(3900)
      expect(panel.text).not.toContain("FOREIGN")
      expect(panel.text).not.toContain("/secret/path")
    }
    expect(render("sessions", snap, f.profile).text).toContain("Моя &lt;сессия&gt; &amp; отчёт")
  })
  test("autostart quotes paths as XML and never embeds a token", () => {
    const plist = servicePlist("/some path/bun", "/my & app/cli.ts", "/config.json", "/log.txt")
    expect(plist).toContain("/my &amp; app/cli.ts")
    expect(plist).not.toContain(fakeToken)
    expect(plist).toContain("KeepAlive")
  })
})

describe("large context is financially critical", () => {
  test("rejects invalid financial thresholds rather than silently defaulting", () => {
    const f = fixture()
    expect(() => parseConfig({ ...f.raw, context: { ...f.raw.context, criticalInputUsd: "0.1" } })).toThrow("criticalInputUsd")
    expect(() => parseConfig({ ...f.raw, context: { ...f.raw.context, criticalWindowFraction: 2 } })).toThrow("criticalWindowFraction")
  })
  async function monitored(read: number, input: number, readPrice: number, steps = 1) {
    const f = fixture()
    const cfg = parseConfig(f.raw)
    writeFileSync(join(f.dir, "models.json"), JSON.stringify({ version: 2, fetchedAt: Date.now(), specs: [{ id: "m", mode: "chat", inputs: ["text"], contextLimit: 1000000, tiers: [{ fromTokens: null, input: 2, output: 10, cacheRead: readPrice, cacheWrite: 2.5 }] }] }))
    const catalog = new ModelCatalog(null, join(f.dir, "models.json"), () => 60); await catalog.refresh()
    writeFileSync(join(f.dir, "settings.json"), '{"mode":"off"}')
    const monitor = new Monitor(f.config, catalog, async () => { throw new Error("local notifications are off") }, cfg, f.store)
    for (let i = 0; i < steps; i++) await monitor.onStep({ id: `step${i}`, at: Date.now(), sessionId: "s", sessionTitle: "Дорогая сессия", directory: "/project", model: { id: "m" }, tokens: { input, output: 0, reasoning: 0, cache: { read, write: 0 } } })
    return f
  }
  test("high cache hit ratio can still have an expensive recurring input", async () => {
    const f = await monitored(700000, 1000, .2)
    const a = f.store.readAlerts(100).find((a) => a.title.startsWith("Дорогой контекст"))!
    expect(a.severity).toBe("critical")
    expect(a.body).toContain("$0.14")
    expect(f.store.readSession("s")!.lastStepRisk!.expensiveInput).toBe(true)
    expect(f.store.readSession("s")!.lastStepCharges!.cacheReadUsd).toBeCloseTo(.14)
  })
  test("cheap large cache is not incorrectly called an expensive input", async () => {
    const f = await monitored(700000, 1000, .01)
    expect(f.store.readAlerts(100).some((a) => a.title.startsWith("Дорогой контекст"))).toBe(false)
  })
  test("near-full window is critical even when cache input is cheap", async () => {
    const f = await monitored(940000, 1000, .01)
    expect(f.store.readAlerts(100).find((a) => a.title.startsWith("Окно контекста"))!.severity).toBe("critical")
  })
  test("loss of cache on big context is critical even with local notifications off", async () => {
    const f = await monitored(1000, 250000, .2, 2)
    const alerts = f.store.readAlerts(100)
    expect(alerts.find((a) => a.kind === "cache")!.severity).toBe("critical")
    collectAlerts(f.dir, f.state, false)
    expect(f.state.pending.some((a) => a.title.startsWith("Чтение кеша"))).toBe(true)
    expect(alerts.every((a) => typeof a.id === "string")).toBe(true)
  })
  test("context risk is throttled within its cooldown", async () => {
    const f = await monitored(700000, 1000, .2, 3)
    expect(f.store.readAlerts(100).filter((a) => a.title.startsWith("Дорогой контекст"))).toHaveLength(1)
  })
  test("a price tier already crossed is not described as a future increase", async () => {
    const f = fixture()
    const file = join(f.dir, "models.json")
    writeFileSync(file, JSON.stringify({ version: 2, fetchedAt: Date.now(), specs: [{ id: "m", mode: "chat", inputs: ["text"], contextLimit: 1000000, tiers: [
      { fromTokens: null, input: 2, output: 10, cacheRead: .2, cacheWrite: 2.5 },
      { fromTokens: 100000, input: 4, output: 15, cacheRead: .4, cacheWrite: 5 },
    ] }] }))
    const catalog = new ModelCatalog(null, file, () => 60); await catalog.refresh()
    const monitor = new Monitor(f.config, catalog, async () => {}, parseConfig(f.raw), f.store)
    await monitor.onStep({ id: "price", at: Date.now(), sessionId: "s", sessionTitle: "Тариф", directory: "/project", model: { id: "m" }, tokens: { input: 300000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    const a = f.store.readAlerts(100).find((a) => a.title.startsWith("Высокий тариф контекста"))!
    expect(a.body).toContain("уже действует")
    expect(a.body).not.toContain("цена вырастет")
  })
})

describe("three focused Telegram reports", () => {
  function addSession(f: ReturnType<typeof fixture>, index: number, at: number) {
    f.store.writeSession({
      accountingVersion: ACCOUNTING_VERSION, id: `s${index}`, title: `Рабочая сессия ${index}`, directory: "/private/project",
      model: { providerID: "litellm", id: "claude-sonnet", variant: "high" }, cost: index, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 250000, write: 1000 } },
      steps: 10, lastStepAt: at, lastStepCost: .12, contextTokens: 310000, contextLimit: 1000000, cacheReadRatio: 250000 / 310000, cacheStreak: 0, stepCosts: [],
      lastStepTokens: { input: 59000, output: 30, reasoning: 10, cache: { read: 250000, write: 1000 } },
      lastStepCharges: { inputUsd: .1, outputUsd: .02, cacheReadUsd: .03, cacheWriteUsd: .06 },
      lastStepRisk: { expensiveInput: true, windowFull: false, cacheLoss: false, spike: false, priceTier: false },
    })
  }
  test("status contains only budget, forecast and activity count, not a session list", async () => {
    const f = fixture()
    const now = Date.UTC(2026, 9, 20, 12)
    for (let i = 1; i <= 5; i++) addSession(f, i, now - i * 1000)
    f.store.appendSample(String(periodStart(new Date(now), 0).getTime()), { t: now, spend: 40, maxBudget: 200 })
    const snap = await snapshot(f.config, now)
    const panel = render("status", snap, f.profile)
    expect(panel.text).toContain("$160.00")
    expect(panel.text).toContain("Потрачено <b>$40.00</b> из $200.00")
    expect(panel.text).not.toContain("Рабочая сессия")
    expect(panel.text).toContain("Выполняются сессии: <b>0</b>")
    expect(panel.text).not.toContain("<blockquote")
    expect(panel.parseMode).toBe("HTML")
    expect(Object.keys(panel)).toEqual(["text", "parseMode"])
    expect(panel.text).not.toContain("Данные ключа:")
    expect(panel.text).toContain("00:00 UTC\n\n")
  })
  test("личные лимиты и оценка месяца не маскируются под расход LiteLLM", async () => {
    const f = fixture(); const now = Date.UTC(2026, 9, 20, 12)
    writeFileSync(f.config, JSON.stringify({ ...f.raw, planningBudget: { dailyUsd: 300, monthlyUsd: 4000 } }))
    f.store.appendSample(String(Date.UTC(2026, 9, 19)), { t: Date.UTC(2026, 9, 19, 12), spend: 50, maxBudget: 200 })
    f.store.appendSample(String(Date.UTC(2026, 9, 20)), { t: now, spend: 40, maxBudget: 200 })
    const text = render("status", await snapshot(f.config, now), f.profile).text
    expect(text).toContain("$90.00 за 2 из 20 дней")
    expect(text).toContain("Остаток по имеющимся данным ≈ $3910.00")
    expect(text).toContain("можно ≈ $200.00/день (упирается в лимит ключа)")
    expect(text).not.toContain("Ориентир")
    expect(text).toContain("Потрачено <b>$40.00</b> из $200.00")
  })
  test("forecast uses the wall-clock hour up to the report time", async () => {
    const f = fixture(); const now = Date.UTC(2026, 9, 20, 12)
    const period = String(periodStart(new Date(now), 0).getTime())
    f.store.appendSample(period, { t: now - 50 * 60000, spend: 45, maxBudget: 200 })
    f.store.appendSample(period, { t: now - 20 * 60000, spend: 50, maxBudget: 200 })
    const text = render("status", await snapshot(f.config, now), f.profile).text
    expect(text).toContain("Темп за последний час ≈ <b>$5.00/ч</b>")
    expect(text).toContain("К сбросу останется ≈ <b>$90.00</b>")
    expect(text).not.toContain("Данные ключа:")
  })
  test("negative gateway spend switches to an explicitly incomplete local estimate", async () => {
    const f = fixture(); const now = Date.UTC(2026, 9, 25, 12)
    f.store.appendSample(String(periodStart(new Date(now), 0).getTime()), { t: now, spend: -184.50577, maxBudget: 200 })
    const text = render("status", await snapshot(f.config, now), f.profile).text
    expect(text).toContain("Локальная оценка: учтено шагов LiteLLM: 0")
    expect(text).toContain("Пропущенные запросы и другие клиенты не учтены")
    expect(text).toContain("$-184.51")
    expect(text).not.toContain("$384.51")
    expect(text).toContain("до 00:00 UTC")
  })
  test("forecast reports a deficit instead of a negative remaining balance", async () => {
    const f = fixture(); const now = Date.UTC(2026, 9, 20, 12)
    const period = String(periodStart(new Date(now), 0).getTime())
    f.store.appendSample(period, { t: now - 30 * 60000, spend: 180, maxBudget: 200 })
    f.store.appendSample(period, { t: now, spend: 190, maxBudget: 200 })
    const text = render("status", await snapshot(f.config, now), f.profile).text
    expect(text).toContain("дефицит ≈ <b>$110.00</b>")
    expect(text).not.toContain("К сбросу останется")
  })
  test("session report shows at most four compact sessions, without nested navigation", async () => {
    const f = fixture(); const now = Date.now()
    for (let i = 1; i <= 5; i++) addSession(f, i, now - i * 1000)
    const panel = render("sessions", await snapshot(f.config), f.profile)
    expect(panel.text).toContain("<b>Рабочая сессия 1</b>")
    expect(panel.text).toContain("<b>Рабочая сессия 4</b>")
    expect(panel.text).not.toContain("Рабочая сессия 5")
    expect(panel.text).toContain("из кеша 250k · 80.6%")
    expect(panel.text).toContain("последний шаг ≈ $0.12")
    expect(panel.text).not.toContain("<blockquote")
    expect(Object.keys(panel)).toEqual(["text", "parseMode"])
  })
  test("all current sessions and four recent sessions are distinct, independent groups", async () => {
    const f = fixture(); const now = Date.now()
    for (let i = 1; i <= 8; i++) addSession(f, i, now - i * 1000)
    f.store.markRunning("s1"); f.store.markRunning("s2")
    const panel = render("sessions", await snapshot(f.config), f.profile)
    expect(panel.text).toContain("🟢 <b>Текущие · 2</b>\n\n🔹")
    expect(panel.text).toContain("🕓 <b>Недавние · 4</b>\n\n🔹")
    for (let i = 1; i <= 6; i++) expect(panel.text).toContain(`<b>Рабочая сессия ${i}</b>`)
    expect(panel.text).not.toContain("Рабочая сессия 7")
    expect(panel.navigation).toBeUndefined()
  })
  test("long session reports paginate without losing any current session or splitting records", async () => {
    const f = fixture(); const now = Date.now()
    for (let i = 1; i <= 35; i++) {
      addSession(f, i, now - i * 1000)
      if (i <= 27) f.store.markRunning(`s${i}`)
    }
    const snap = await snapshot(f.config)
    const first = render("sessions", snap, f.profile)
    expect(first.navigation!.count).toBeGreaterThan(1)
    const seen: number[] = []
    for (let index = 0; index < first.navigation!.count; index++) {
      const page = render("sessions", snap, f.profile, index)
      expect(page.text.length).toBeLessThan(3900)
      expect(page.navigation!.index).toBe(index)
      expect(page.text).toContain(`Страница ${index + 1}/${first.navigation!.count}`)
      for (const match of page.text.matchAll(/<b>Рабочая сессия (\d+)<\/b>/g)) seen.push(Number(match[1]))
    }
    expect(seen).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    expect(render("sessions", snap, f.profile, 99999).navigation!.index).toBe(first.navigation!.count - 1)
    expect(() => render("sessions", snap, f.profile, -1)).toThrow("invalid session page")
  })
  test("page controls keep all three main buttons and route to the requested session page", async () => {
    const f = fixture(); const now = Date.now()
    for (let i = 1; i <= 50; i++) { addSession(f, i, now - i * 1000); f.store.markRunning(`s${i}`) }
    const snap = await snapshot(f.config)
    let delivered: import("../adapters/telegram/api.ts").Panel | undefined
    await handleUpdate(update("Сессии 2 →"), f.profile, snap, { panel: async (_chat, panel) => { delivered = panel }, answer: async () => {} })
    expect(delivered!.navigation!.index).toBe(1)
    let body!: { reply_markup: { keyboard: { text: string }[][] } }
    const api = new TelegramApi(fakeToken, async (_url, request) => { body = JSON.parse(String(request.body)); return Response.json({ ok: true, result: {} }) })
    await api.panel(42, delivered!)
    expect(body.reply_markup.keyboard[0]).toEqual([...BOT_KEYBOARD.keyboard[0]])
    expect(body.reply_markup.keyboard[1]).toContainEqual({ text: "← Сессии 1" })
    expect(body.reply_markup.keyboard[1]).toContainEqual({ text: "Сессии 3 →" })
  })
  test("only three persistent keyboard buttons and three menu commands are exposed", () => {
    expect(COMMANDS.map((c) => c.command)).toEqual(["status", "session", "alerts"])
    expect(BOT_KEYBOARD.keyboard).toEqual([[{ text: "Статус" }, { text: "Сессия" }, { text: "Алерты" }]])
    expect(BOT_KEYBOARD.is_persistent).toBe(true)
    expect(BOT_KEYBOARD.one_time_keyboard).toBe(false)
  })
  test("both text buttons and slash commands route to the same reports", async () => {
    const f = fixture(); const snap = await snapshot(f.config)
    for (const [input, title] of [["Статус", "Статус LiteLLM"], ["/status", "Статус LiteLLM"], ["/start", "Статус LiteLLM"], ["Сессия", "Сессии LiteLLM"], ["/session", "Сессии LiteLLM"], ["/sessions", "Сессии LiteLLM"], ["Алерты", "Последние алерты"], ["/alerts", "Последние алерты"]]) {
      let sent = ""
      await handleUpdate(update(input), f.profile, snap, { panel: async (_chat, panel) => { sent = panel.text }, answer: async () => {} })
      expect(sent).toContain(title)
    }
  })
  test("old settings buttons no longer mutate notification settings", async () => {
    const f = fixture()
    const snap = await snapshot(f.config)
    let sent = ""
    let oldMessage: number | undefined
    await handleUpdate({ id: 2, actor: update().actor, callback: { id: "q", data: "notify:off", messageId: 10 } }, f.profile, snap, {
      panel: async (_chat, panel, messageId) => { sent = panel.text; oldMessage = messageId }, answer: async () => {},
    })
    expect(f.state.enabled).toBe(true)
    expect(sent).toContain("Статус LiteLLM")
    expect(oldMessage).toBe(10)
  })
  test("API sends literal plain text and a reply keyboard, not inline navigation", async () => {
    let body: Record<string, unknown> = {}
    const api = new TelegramApi(fakeToken, async (_url, request) => { body = JSON.parse(String(request.body)); return Response.json({ ok: true, result: {} }) })
    await api.panel(42, { text: "Сессия <b>не разметка</b> & данные" })
    expect(body.text).toContain("<b>не разметка</b>")
    expect(body.parse_mode).toBeUndefined()
    expect(body.reply_markup).toEqual(BOT_KEYBOARD)
  })
  test("API enables HTML only when a formatted report explicitly requests it", async () => {
    let body: Record<string, unknown> = {}
    const api = new TelegramApi(fakeToken, async (_url, request) => { body = JSON.parse(String(request.body)); return Response.json({ ok: true, result: {} }) })
    const f = fixture()
    await api.panel(42, render("status", await snapshot(f.config), f.profile))
    expect(body.parse_mode).toBe("HTML")
    expect(body.reply_markup).toEqual(BOT_KEYBOARD)
  })
  test("a legacy inline message loses its buttons before a new plain report is sent", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    const api = new TelegramApi(fakeToken, async (url, request) => {
      calls.push({ method: url.split("/").at(-1)!, body: JSON.parse(String(request.body)) })
      return Response.json({ ok: true, result: true })
    })
    await api.panel(42, { text: "Расходы LiteLLM" }, 10)
    expect(calls.map((c) => c.method)).toEqual(["editMessageReplyMarkup", "sendMessage"])
    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] })
    expect(calls[1].body.reply_markup).toEqual(BOT_KEYBOARD)
    expect(calls[1].body.parse_mode).toBeUndefined()
  })
  test("alerts show the ten latest critical events even when newer warnings exist", async () => {
    const f = fixture()
    for (let i = 0; i < 12; i++) f.store.appendAlert({ ...alert(String(i)), at: 1000 + i, title: `Событие ${i}`, body: "Вход $0.14. Контекст 700k. Рассмотрите новую сессию." })
    for (let i = 0; i < 10; i++) f.store.appendAlert({ ...alert(`warn-${i}`, "warn"), at: 2000 + i, title: "Новое предупреждение" })
    const panel = render("alerts", await snapshot(f.config), f.profile)
    for (let i = 2; i < 12; i++) expect(panel.text).toContain(`<b>Событие ${i}</b>`)
    expect(panel.text).not.toContain("<b>Событие 0</b>")
    expect(panel.text).not.toContain("<b>Событие 1</b>")
    expect(panel.text).not.toContain("<blockquote>")
    expect(panel.text).toContain("Вход $0.14. Контекст 700k.")
    expect(panel.text).not.toContain("Рассмотрите")
    expect(panel.text).toContain("🔴 <b>Событие 11</b>")
    expect(panel.text).not.toContain("Новое предупреждение")
  })
  test("ten long alerts fit in a single Telegram message including escaped HTML", async () => {
    const f = fixture()
    for (let i = 0; i < 10; i++) f.store.appendAlert({ ...alert(String(i)), title: "<&".repeat(500), subtitle: "<&".repeat(500), body: "<&".repeat(500) })
    const text = render("alerts", await snapshot(f.config), f.profile).text
    expect(text.match(/🔴 <b>/g)).toHaveLength(11)
    expect(text.length).toBeLessThan(3900)
    expect(text.replace(/<\/?[bi]>/g, "")).not.toMatch(/[<>]/)
  })
  test("manual-only mode suppresses delivery but still answers the alert button", async () => {
    const f = fixture()
    f.state.enabled = false
    f.state.pending = [alert("queued")]
    await deliver(f.state, f.profile, { panel: async () => { throw new Error("must not send automatically") } }, () => {})
    f.store.appendAlert(alert("new-critical"))
    collectAlerts(f.dir, f.state, false)
    expect(f.state.pending).toEqual([])
    const file = join(f.dir, "state.json")
    saveJson(file, f.state)
    expect(parseState(readJson(file), f.profile).enabled).toBe(false)
    let text = ""
    await handleUpdate(update("Алерты"), f.profile, await snapshot(f.config), { panel: async (_chat, panel) => { text = panel.text }, answer: async () => {} })
    expect(text).toContain("Дорогой контекст")
    expect(f.state.enabled).toBe(false)
  })
  test("warning and informational events never appear in Telegram alerts", async () => {
    const f = fixture()
    f.store.appendAlert({ ...alert("a"), title: "Критическое", severity: "critical" })
    f.store.appendAlert({ ...alert("b"), title: "Предупреждение", severity: "warn" })
    f.store.appendAlert({ ...alert("c"), title: "Информация", severity: "info" })
    const text = render("alerts", await snapshot(f.config), f.profile).text
    expect(text).toContain("🔴 <b>Критическое</b>")
    expect(text).not.toContain("Предупреждение")
    expect(text).not.toContain("Информация")
  })
  test("reports no critical alerts when only warnings exist", async () => {
    const f = fixture()
    f.store.appendAlert(alert("warning", "warn"))
    expect(render("alerts", await snapshot(f.config), f.profile).text).toContain("Критических алертов нет.")
  })
  test("zero input is not displayed as 100 percent cache", async () => {
    const f = fixture(); addSession(f, 1, Date.now())
    const s = f.store.readSession("s1")!
    f.store.writeSession({ ...s, contextTokens: 0, cacheReadRatio: 1 })
    expect(render("sessions", await snapshot(f.config), f.profile).text).toContain("нет входных данных")
  })
  test("untrusted HTML and extreme lengths stay escaped and within Telegram limits", async () => {
    const f = fixture(); const now = Date.now()
    for (let i = 1; i <= 4; i++) {
      addSession(f, i, now - i * 1000)
      const s = f.store.readSession(`s${i}`)!
      f.store.writeSession({ ...s, title: "<&".repeat(1000), model: { providerID: "litellm", id: "<i>&".repeat(1000) }, cacheReadRatio: .00001 })
      f.store.appendAlert({ ...alert(String(i)), title: "<&".repeat(1000), subtitle: "&".repeat(1000), body: "<b>".repeat(1000) })
    }
    const snap = await snapshot(f.config)
    for (const report of ["status", "sessions", "alerts"] as const) {
      const panel = render(report, snap, f.profile)
      expect(panel.text.length).toBeLessThan(3900)
      expect(panel.text.replace(/<\/?[bi]>/g, "")).not.toMatch(/[<>]/)
      expect(panel.text).not.toContain("<blockquote")
    }
    expect(render("sessions", snap, f.profile).text).toContain("&lt;0.1%")
  })
  test("cache formatting does not turn partial cache into 100 percent", () => {
    expect(formatCachePercent(449589 / 449979)).toBe("99.9%")
    expect(formatCachePercent(.99999)).toBe(">99.9%")
    expect(formatCachePercent(.00001)).toBe("<0.1%")
    expect(formatCachePercent(0)).toBe("0%")
    expect(formatCachePercent(1)).toBe("100%")
    expect(formatCacheTokens(449589)).toBe("449.6k")
  })
})
