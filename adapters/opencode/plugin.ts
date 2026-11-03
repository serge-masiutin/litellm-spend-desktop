import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { formatReport, formatShort } from "../../core/format.ts"
import { createRuntime } from "../../core/runtime.ts"
import { parseKeyHeaders } from "../../core/litellm.ts"
import { hasBudgetEstimate } from "../../core/daily-budget.ts"
import { isChatModel, type ModelSpec } from "../../core/pricing.ts"
import { LitellmSpend } from "./rpc.ts"
import { SessionEvents, type SessionEvent } from "./session-events.ts"

const CONFIG_PATH = fileURLToPath(new URL("../../config.json", import.meta.url))
const POLL_TICK_MS = 60_000

function costTiers(spec: ModelSpec) {
  return spec.tiers.map((tier) => ({
    ...(tier.fromTokens === null ? {} : { tier: { type: "context" as const, size: tier.fromTokens } }),
    input: tier.input,
    output: tier.output,
    cache: { read: tier.cacheRead ?? tier.input, write: tier.cacheWrite ?? tier.input },
  }))
}

/**
 * Адаптер OpenCode: приводит события и каталог моделей OpenCode к нейтральному ядру (core/).
 * Здесь нет ни расчётов, ни порогов: они живут в ядре и одинаковы для любого агента.
 */
export default Plugin.define({
  id: "litellm-spend",
  async setup(ctx) {
    const { monitor, catalog } = createRuntime(CONFIG_PATH)
    const { store } = monitor
    store.log("litellm-spend runtime ready: session-lock-v1, monthly-v1")
    // Хук HTTP и фильтр шагов должны использовать один провайдер весь срок жизни регистрации.
    const providerID = monitor.cfg.models.providerId
    const sessionEvents = new SessionEvents(providerID, monitor, ctx.session)

    // Цены и лимиты моделей подставляются из LiteLLM на каждой перезагрузке каталога OpenCode
    const transform = await ctx.model.transform((editor) => {
      for (const spec of catalog.all()) {
        if (!isChatModel(spec)) continue
        editor.update(providerID, spec.id, (model) => {
          if (spec.tiers.length > 0) model.cost = costTiers(spec)
          // Только дополняем форматы: уже заданные в конфиге остаются
          for (const input of spec.inputs) if (!model.capabilities.input.includes(input)) model.capabilities.input.push(input)
          if (spec.contextLimit !== undefined) model.limit.context = spec.contextLimit
          if (spec.outputLimit !== undefined) model.limit.output = spec.outputLimit
        })
      }
    })

    async function syncModels(force: boolean): Promise<void> {
      try {
        if (await catalog.refresh(force)) {
          await ctx.model.reload()
          store.log(`model catalog applied: ${catalog.all().length} models`)
        }
      } catch (error) {
        store.log(`model catalog refresh failed: ${String(error)}`)
      }
    }
    await syncModels(false)

    const registration = await ctx.rpc.register(LitellmSpend, {
      get: async () => {
        const view = monitor.currentKeyView(Date.now())
        return { key: view === null ? null : { spend: view.sample.spend, maxBudget: view.sample.maxBudget, updatedAt: view.sample.t, estimated: view.budget !== undefined, available: hasBudgetEstimate(view.budget) } }
      },
    })

    const publish = async () => {
      const view = monitor.currentKeyView(Date.now())
      if (view !== null) await registration.events.emit("updated", { spend: view.sample.spend, maxBudget: view.sample.maxBudget, updatedAt: view.sample.t, estimated: view.budget !== undefined, available: hasBudgetEstimate(view.budget) })
    }

    const hook = await ctx.session.hook(
      "http.response",
      async (event) => {
        const reading = parseKeyHeaders(event.response.headers)
        if (reading === null) return
        try {
          await monitor.onKeySample(reading.spend, reading.maxBudget)
          await publish()
        } catch (error) {
          store.log(`key sample handling failed: ${String(error)}`)
        }
      },
      { providerID },
    )

    // Каталог моделей и цен обновляется раз в refreshMinutes; запросов к моделям плагин не делает
    const timer = setInterval(() => void syncModels(false), POLL_TICK_MS)

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (!event.type.startsWith("session.step.") && !event.type.startsWith("session.execution.")) continue
          try {
            await sessionEvents.handle(event as unknown as SessionEvent)
            if (event.type === "session.step.ended") await publish()
          } catch (error) {
            store.log(`session event handling failed: ${String(error)}`)
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) store.log(`event stream failed: ${String(error)}`)
      }
    })()

    const command = await ctx.command.transform((editor) => {
      editor.add({
        name: "spend",
        description: "Расход ключа LiteLLM и сессий: /spend — кратко, /spend report — полная сводка, /spend sync — обновить цены и модели",
        execute: async ({ sessionID, prompt, delivery }) => {
          monitor.refreshConfig()
          const argument = prompt.text.trim().toLowerCase()
          const nowMs = Date.now()
          if (argument === "report") {
            const sessions = store.listSessions()
            const text = formatReport({
              key: monitor.currentKeyView(nowMs),
              monthly: monitor.currentMonthlyEstimate(nowMs),
              sessions: sessions.records,
              corrupt: sessions.corrupt,
              alerts: store.readAlerts(monitor.cfg.report.lastAlerts),
              nowMs,
              cfg: monitor.cfg,
            })
            await ctx.session.prompt({ sessionID, text, delivery })
            return
          }
          if (argument === "sync") {
            await syncModels(true)
            await ctx.session.synthetic({ sessionID, text: `Каталог обновлён: ${catalog.all().length} моделей, цены из LiteLLM.` })
            return
          }
          const text =
            argument === ""
              ? formatShort(monitor.currentKeyView(nowMs), nowMs, monitor.currentMonthlyEstimate(nowMs), monitor.cfg.planningBudget)
              : "Неизвестный аргумент. Доступно: /spend, /spend report, /spend sync."
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    return () => {
      clearInterval(timer)
      abort.abort()
      void hook.dispose()
      void registration.dispose()
      void command.dispose()
      void transform.dispose()
    }
  },
})
