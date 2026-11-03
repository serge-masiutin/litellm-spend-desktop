import { statSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loadConfigFile, type Config } from "./config.ts"
import type { ModelCatalog } from "./catalog.ts"
import { basename, fmtMinutes, fmtTokens, formatCachePercent, safeText, usd } from "./format.ts"
import { expandHome } from "./litellm.ts"
import { MonthlyEstimator, type MonthlyEstimate } from "./monthly.ts"
import { budgetStepsForDay, hasBudgetEstimate, localDayBudget, parseBudgetDay, utcDayStart, UTC_DAY_MS, type BudgetStep, type LocalBudgetInfo } from "./daily-budget.ts"
import type { Notifier } from "./notify.ts"
import { stepCharges, stepCost } from "./pricing.ts"
import {
  cacheReadRatio,
  contextLevels,
  contextTokens,
  crossed,
  forecastKey,
  isSpike,
  median,
  nextCacheStreak,
  nextReset,
  periodStart,
  sessionCostLevels,
  sessionStepUsd,
  shouldNotify,
  type Tokens,
} from "./rules.ts"
import { ACCOUNTING_VERSION, DEFAULT_NOTIFY_SETTINGS, Store, type AlertRecord, type KeySampleRecord, type NotifySettings, type Severity } from "./store.ts"

const STEP_HISTORY = 50

/** Событие шага в нейтральном виде: адаптер агента приводит к нему свои события. */
export interface StepEvent {
  id: string
  at: number
  sessionId: string
  sessionTitle: string
  directory: string
  ancestorIds?: string[]
  ancestryComplete?: boolean
  model: { id: string; variant?: string }
  tokens: Tokens
  /** Стоимость, посчитанная самим агентом. Нужна только как запасной вариант, если у модели нет цены в LiteLLM. */
  reportedStepCost?: number
}

export interface KeyView {
  budget?: LocalBudgetInfo
  sample: KeySampleRecord
  samples: KeySampleRecord[]
  nowMs: number
  cfg: Config
}

/**
 * Мониторинг расходов поверх LiteLLM. Не зависит от конкретного агента:
 * серверный расход приходит из заголовков (onKeySample), локальный резерв — из шагов (onStep) и ручных поправок. Экземпляров может быть несколько (разные агенты, папки проектов),
 * поэтому дедупликация идёт через атомарные файлы-замки в общем хранилище.
 */
export class Monitor {
  cfg: Config
  readonly store: Store
  private cfgMtime: number
  private configError: string | null = null
  private readonly monthly: MonthlyEstimator

  constructor(
    private readonly configPath: string,
    readonly catalog: ModelCatalog,
    private readonly notifier: Notifier,
    initial: Config,
    store: Store,
  ) {
    this.cfg = initial
    this.store = store
    this.cfgMtime = statSync(configPath).mtimeMs
    this.monthly = new MonthlyEstimator(store)
  }

  static storageDir(cfg: Config): string {
    return expandHome(cfg.storage.dir)
  }

  /** Пороги правятся из приложения, поэтому читаем их заново при изменении файла. Битый файл не останавливает мониторинг. */
  refreshConfig(): void {
    const mtime = statSync(this.configPath).mtimeMs
    if (mtime === this.cfgMtime) return
    this.cfgMtime = mtime
    try {
      const next = loadConfigFile(this.configPath)
      if (next.models.providerId !== this.cfg.models.providerId) throw new Error("models.providerId changed: reload the plugin to rebind provider hooks")
      this.cfg = next
      this.configError = null
      this.store.log("config reloaded")
    } catch (error) {
      this.configError = String(error)
      this.store.log(`config reload failed, keeping previous thresholds: ${this.configError}`)
    }
  }

  periodFile(nowMs: number): string {
    return String(periodStart(new Date(nowMs), this.cfg.keyBudget.resetHourUtc).getTime())
  }

  private periodId(nowMs: number): string {
    return `${this.periodFile(nowMs)}-r0`
  }

  currentKeyView(nowMs: number): KeyView | null {
    const start = utcDayStart(nowMs)
    const local = this.localBudget(start)
    if (local !== null) {
      const raw = this.daySamples(start)
      const latest = raw[raw.length - 1] ?? this.store.latestSample(this.periodFile(nowMs))
      // Ручная поправка истории не выдумывает лимит ключа, если заголовков ещё не было.
      if (latest === null) return null
      const known = hasBudgetEstimate(local.info)
      const samples = known ? local.points.map((point) => ({ ...point, maxBudget: latest.maxBudget })) : []
      const updatedAt = Math.max(samples[samples.length - 1]?.t ?? latest.t, latest.t)
      return { sample: { t: updatedAt, spend: local.spend, maxBudget: latest.maxBudget }, samples, budget: local.info, nowMs, cfg: this.cfg }
    }
    const samples = this.store.readSamples(this.periodFile(nowMs)).sort((a, b) => a.t - b.t)
    return samples.length === 0 ? null : { sample: samples[samples.length - 1], samples, nowMs, cfg: this.cfg }
  }

  currentMonthlyEstimate(nowMs: number): MonthlyEstimate | null {
    if (this.cfg.planningBudget === undefined) return null
    const steps = this.store.readBudgetSteps(this.cfg.models.providerId)
    return this.monthly.estimate(nowMs, this.cfg.keyBudget.resetHourUtc, (start) => {
      const local = this.localBudget(utcDayStart(start), steps)
      if (local !== null && !hasBudgetEstimate(local.info)) return "unavailable"
      return local === null ? null : { spend: local.spend, firstAt: utcDayStart(start), source: local.info.source }
    })
  }

  private daySamples(start: number): KeySampleRecord[] {
    const periods = new Set([this.periodFile(start), this.periodFile(start + UTC_DAY_MS - 1)])
    return [...periods].flatMap((period) => this.store.readSamples(period)).filter((sample) => sample.t >= start && sample.t < start + UTC_DAY_MS).sort((a, b) => a.t - b.t)
  }

  private localBudget(start: number, steps?: BudgetStep[]) {
    const raw = this.daySamples(start)
    const correction = this.store.readBudgetCorrection(start)
    if (correction === null && !raw.some((sample) => sample.spend < 0)) return null
    return localDayBudget(start, raw, steps ?? this.store.readBudgetSteps(this.cfg.models.providerId), correction)
  }

  async correctDailyBudget(day: string, amount: number): Promise<void> {
    const now = Date.now()
    const start = parseBudgetDay(day, now)
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Расход должен быть конечным неотрицательным числом USD")
    await this.store.withBudgetLock(() => {
      const steps = budgetStepsForDay(this.store.readBudgetSteps(this.cfg.models.providerId), start)
      this.store.writeBudgetCorrection(start, { at: Math.min(now, start + UTC_DAY_MS - 1), amount, includedStepIds: steps.map((step) => step.id) })
      this.publishBudget(now)
    })
  }

  private async fire(alert: Omit<AlertRecord, "at">): Promise<void> {
    const record: AlertRecord = { ...alert, id: randomUUID(), at: Date.now(), accountingVersion: ACCOUNTING_VERSION, notificationsSuppressed: this.store.notificationsPaused() }
    this.store.appendAlert(record)
    if (record.notificationsSuppressed) return
    let settings: NotifySettings
    try {
      settings = this.store.readSettings()
    } catch (error) {
      this.store.log(`settings unreadable, notifying anyway: ${String(error)}`)
      settings = DEFAULT_NOTIFY_SETTINGS
    }
    if (shouldNotify(record.severity, settings.mode)) await this.notifier(record)
  }

  private severityForPercent(percent: number): Severity {
    return percent >= 90 ? "critical" : percent >= 75 ? "warn" : "info"
  }

  async onKeySample(spend: number, maxBudget: number): Promise<void> {
    if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) throw new Error("invalid key sample")
    this.refreshConfig()
    const view = await this.store.withBudgetLock(() => {
      const nowMs = Date.now()
      this.store.appendSample(this.periodFile(nowMs), { t: nowMs, spend, maxBudget })
      return this.publishBudget(nowMs)
    })
    if (view !== null) await this.checkBudgetAlerts(view)
  }

  private publishBudget(nowMs: number): KeyView | null {
    const { cfg, store } = this
    const view = this.currentKeyView(nowMs)
    if (view === null) {
      store.updateStatusMonthly(this.currentMonthlyEstimate(nowMs))
      return null
    }
    const { spend, maxBudget } = view.sample
    const currentPeriodStart = view.budget === undefined ? periodStart(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : utcDayStart(nowMs)
    const forecast = forecastKey(view.samples, nowMs, currentPeriodStart, maxBudget, cfg.forecast)
    let monthlyEstimate = null
    let monthlyError = null
    if (cfg.planningBudget !== undefined) {
      try {
        monthlyEstimate = this.currentMonthlyEstimate(nowMs)
      } catch (error) {
        monthlyError = "Не удалось прочитать историю месячного расхода"
        store.log(`monthly estimate failed: ${String(error)}`)
      }
    }
    store.writeStatus({
      updatedAt: view.sample.t,
      spend,
      maxBudget,
      periodStartAt: currentPeriodStart,
      nextResetAt: view.budget === undefined ? nextReset(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : currentPeriodStart + UTC_DAY_MS,
      budget: view.budget,
      budgetSamples: view.budget === undefined ? undefined : view.samples,
      forecast,
      paceWindowMinutes: cfg.forecast.windowMinutes,
      paceMinWindowMinutes: cfg.forecast.minSpanMinutes,
      planningBudget: cfg.planningBudget ?? null,
      monthlyEstimate,
      monthlyError,
      thresholdsPercent: cfg.keyBudget.thresholdsPercent,
      contextThresholdsTokens: cfg.context.thresholdsTokens,
      activeWithinMinutes: cfg.report.activeWithinMinutes,
      cacheMinContextTokens: cfg.cache.minContextTokens,
      cacheMinReadRatio: cfg.cache.minReadRatio,
      configError: this.configError,
    })
    return view
  }

  private async checkBudgetAlerts(view: KeyView): Promise<void> {
    const { cfg, store } = this
    const { nowMs, sample: { spend, maxBudget } } = view
    const start = view.budget === undefined ? periodStart(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : utcDayStart(nowMs)
    const reset = view.budget === undefined ? nextReset(new Date(nowMs), cfg.keyBudget.resetHourUtc).getTime() : start + UTC_DAY_MS
    const forecast = forecastKey(view.samples, nowMs, start, maxBudget, cfg.forecast)
    const id = `${this.periodId(nowMs)}:${view.budget === undefined ? "gateway" : "local"}`
    const source = view.budget === undefined ? "" : "Локальная оценка. "
    const percent = (spend / maxBudget) * 100
    const newlyCrossed = crossed(percent, cfg.keyBudget.thresholdsPercent).filter((threshold) => store.claim(`key:${id}:${threshold}`))
    if (newlyCrossed.length > 0) {
      const threshold = newlyCrossed[newlyCrossed.length - 1]
      await this.fire({
        kind: "budget",
        severity: this.severityForPercent(threshold),
        title: `Ключ LiteLLM: ${Math.round(percent)}% бюджета`,
        body: `${source}Потрачено ${usd(spend)} из ${usd(maxBudget)}, осталось ${usd(maxBudget - spend)}. Сброс через ${fmtMinutes((reset - nowMs) / 60_000)}.`,
      })
    }

    if (forecast === null || forecast.hoursToExhaust === null) return
    const minutesLeft = forecast.hoursToExhaust * 60
    const minutesToReset = (reset - nowMs) / 60_000
    if (minutesLeft >= minutesToReset) return
    const critical = minutesLeft < cfg.forecast.criticalMinutes
    if (!store.claim(`forecast:${id}:${critical ? "critical" : "warn"}`)) return
    await this.fire({
      kind: "forecast",
      severity: critical ? "critical" : "warn",
      title: "Ключ LiteLLM закончится до сброса",
      body: `${source}Темп ≈ ${usd(forecast.ratePerHour)}/ч, остатка хватит на ${fmtMinutes(minutesLeft)}, до сброса ${fmtMinutes(minutesToReset)}.`,
    })
  }

  async onStep(event: StepEvent): Promise<void> {
    if (!Number.isFinite(event.at) || (event.reportedStepCost !== undefined && (!Number.isFinite(event.reportedStepCost) || event.reportedStepCost < 0))) throw new Error("invalid step time or cost")
    const tokenCounts = [event.tokens.input, event.tokens.output, event.tokens.reasoning, event.tokens.cache.read, event.tokens.cache.write]
    if (tokenCounts.some((count) => !Number.isFinite(count) || count < 0)) throw new Error("invalid step tokens")
    const { store } = this
    this.refreshConfig()
    const writeSessionStep = () => {
      const previous = store.readSession(event.sessionId)
      if (store.stepApplied(event.id, previous)) return null
      const { cfg } = this
      const spec = this.catalog.get(event.model.id)
      // Цена шага берётся из прайса LiteLLM; цифра агента — только когда у модели нет цены
      const priced = spec === undefined ? null : stepCost(event.tokens, spec)
      const charges = spec === undefined ? null : stepCharges(event.tokens, spec)
      const stepUsd = priced ?? event.reportedStepCost ?? 0
      const history = previous?.stepCosts ?? []
      const spike = isSpike(stepUsd, history, cfg.spike)
      const streak = nextCacheStreak(previous?.cacheStreak ?? 0, event.tokens, cfg.cache)
      const context = contextTokens(event.tokens)
      // Только наблюдённые шаги LiteLLM: общие итоги сессии содержат и чужих провайдеров.
      const cost = (previous?.cost ?? 0) + stepUsd
      const tokens: Tokens = {
        input: (previous?.tokens.input ?? 0) + event.tokens.input,
        output: (previous?.tokens.output ?? 0) + event.tokens.output,
        reasoning: (previous?.tokens.reasoning ?? 0) + event.tokens.reasoning,
        cache: {
          read: (previous?.tokens.cache.read ?? 0) + event.tokens.cache.read,
          write: (previous?.tokens.cache.write ?? 0) + event.tokens.cache.write,
        },
      }
      const outputPrice = spec?.tiers[0]?.output
      const priceTierSize = spec?.tiers.find((tier) => tier.fromTokens !== null)?.fromTokens ?? undefined
      const expensiveInput = context >= cfg.context.thresholdsTokens[0] && charges !== null && charges.inputUsd >= cfg.context.criticalInputUsd
      const windowFull = spec?.contextLimit !== undefined && context >= spec.contextLimit * cfg.context.criticalWindowFraction
      // Ошибка чтения предка не отменяет уже подтверждённое родство.
      const keepAncestry = previous?.ancestryComplete === true && event.ancestryComplete !== true

      const record = {
        // Один источник оценки риска для macOS и Telegram: интерфейсы не угадывают важность по размеру кеша.
        lastStepRisk: { expensiveInput, windowFull, cacheLoss: streak >= cfg.cache.consecutiveSteps, spike: spike && context >= cfg.cache.minContextTokens, priceTier: priceTierSize !== undefined && context >= Math.floor(priceTierSize * cfg.context.tierWarnFraction) },
        lastStepTokens: event.tokens,
        lastStepCharges: charges,
        accountingVersion: ACCOUNTING_VERSION,
        id: event.sessionId,
        title: event.sessionTitle,
        directory: event.directory,
        ancestorIds: keepAncestry ? previous.ancestorIds : event.ancestorIds ?? previous?.ancestorIds,
        ancestryComplete: keepAncestry ? true : event.ancestryComplete ?? previous?.ancestryComplete,
        appliedStepIds: [...(previous?.appliedStepIds ?? []), event.id],
        budgetSteps: [...(previous?.budgetSteps ?? []), { id: event.id, at: event.at, recordedAt: Date.now(), cost: priced ?? event.reportedStepCost ?? null }],
        model: { id: event.model.id, variant: event.model.variant, providerID: cfg.models.providerId },
        cost,
        tokens,
        steps: (previous?.steps ?? 0) + 1,
        lastStepAt: event.at,
        lastStepCost: stepUsd,
        contextTokens: context,
        contextLimit: spec?.contextLimit,
        cacheReadRatio: cacheReadRatio(event.tokens),
        cacheStreak: streak,
        stepCosts: [...history, stepUsd].slice(-STEP_HISTORY),
      }
      store.writeSession(record)
      // Совместимость со старыми отметками: новая дедупликация уже сохранена в самой записи.
      store.claim(event.id, "steps")
      return { cfg, record, cost, stepUsd, outputPrice, spike, context, history, priceTierSize, expensiveInput, windowFull, charges, streak }
    }
    const applied = await store.withBudgetLock(async () => {
      const applied = await store.withSessionLock(event.sessionId, writeSessionStep)
      // Повтор события восстанавливает представление после сбоя между записью шага и статуса.
      this.publishBudget(Date.now())
      return applied
    })
    if (applied === null) return
    const view = this.currentKeyView(Date.now())
    if (view?.budget !== undefined) await this.checkBudgetAlerts(view)
    const { cfg, record, cost, stepUsd, outputPrice, spike, context, history, priceTierSize, expensiveInput, windowFull, charges, streak } = applied

    const subtitle = safeText(record.title) || basename(record.directory)
    const modelName = `${event.model.id}${event.model.variant ? `#${event.model.variant}` : ""}`

    const stepLimit = sessionStepUsd(outputPrice, cfg.session)
    const costLevels = sessionCostLevels(cost, stepLimit).filter((level) => store.claim(`cost:${event.sessionId}:${level}`))
    if (costLevels.length > 0) {
      const level = costLevels[costLevels.length - 1]
      await this.fire({
        kind: "session-cost",
        severity: level >= stepLimit * 3 ? "critical" : "warn",
        title: `Сессия дороже ${usd(level)} (${modelName})`,
        subtitle,
        body: `Всего ${usd(cost)}, последний шаг ${usd(stepUsd)}, контекст ${fmtTokens(context)}.`,
      })
    }

    if (spike && store.claim(`spike:${event.sessionId}:${Math.floor(event.at / (cfg.spike.cooldownMinutes * 60_000))}`)) {
      await this.fire({
        kind: "spike",
        severity: context >= cfg.cache.minContextTokens ? "critical" : "warn",
        title: `Скачок цены шага (${modelName})`,
        subtitle,
        body: `Шаг стоил ${usd(stepUsd)}, обычно около ${usd(median(history))}. Контекст ${fmtTokens(context)}. Проверьте, не зациклился ли агент.`,
      })
    }

    const levels = contextLevels(context, priceTierSize, cfg.context).filter((level) => store.claim(`ctx:${event.sessionId}:${level.tokens}`))
    if (levels.length > 0) {
      // При скачке через несколько порогов важнее изменение тарифа, а не просто большее число токенов.
      const level = levels.find((candidate) => candidate.isPriceTier) ?? levels[levels.length - 1]
      await this.fire({
        kind: "context",
        severity: level.isPriceTier ? "critical" : level.tokens >= 250_000 ? "warn" : "info",
        title: level.isPriceTier ? `${context > priceTierSize! ? "Высокий тариф контекста" : "Контекст у порога повышения цены"} (${modelName})` : `Контекст ${fmtTokens(context)} (${modelName})`,
        subtitle,
        body: level.isPriceTier
          ? `Контекст ${fmtTokens(context)}. ${context > priceTierSize! ? `Тариф после ${fmtTokens(priceTierSize!)} уже действует.` : `Повышение тарифа после ${fmtTokens(priceTierSize!)}.`} Подумайте о сжатии контекста или новой сессии.`
          : `Каждый шаг тянет ${fmtTokens(context)} токенов контекста и дорожает. Подумайте о сжатии контекста или новой сессии.`,
      })
    }

    if ((expensiveInput || windowFull) && store.claim(`context-risk:${event.sessionId}:${Math.floor(event.at / (cfg.context.riskCooldownMinutes * 60_000))}`)) {
      await this.fire({
        kind: "context",
        severity: "critical",
        title: `${windowFull ? "Окно контекста почти заполнено" : "Дорогой контекст"} (${modelName})`,
        subtitle,
        body: `Контекст ${fmtTokens(context)}, кеш: чтение ${fmtTokens(event.tokens.cache.read)}, запись ${fmtTokens(event.tokens.cache.write)} (${formatCachePercent(record.cacheReadRatio)} чтения). ${charges === null ? "Цена входа неизвестна." : `Вход ≈ ${usd(charges.inputUsd)}/шаг, включая чтение кеша ${usd(charges.cacheReadUsd)}; 10 таких входов ≈ ${usd(charges.inputUsd * 10)}.`} Рассмотрите сжатие или новую сессию.`,
      })
    }

    if (streak >= cfg.cache.consecutiveSteps && store.claim(`cache-risk:${event.sessionId}:${Math.floor(event.at / (cfg.context.riskCooldownMinutes * 60_000))}`)) {
      await this.fire({
        kind: "cache",
        severity: "critical",
        title: `Чтение кеша ниже порога (${modelName})`,
        subtitle,
        body: `Чтение кеша ${formatCachePercent(record.cacheReadRatio)} при контексте ${fmtTokens(context)} уже ${streak} шага подряд. Остальной вход оплачивается по тарифу свежих токенов или записи кеша.`,
      })
    }
  }
}

export function openStore(cfg: Config): Store {
  const store = new Store(Monitor.storageDir(cfg))
  store.prune(Date.now())
  return store
}

export const catalogFile = (cfg: Config) => join(Monitor.storageDir(cfg), "models.json")
