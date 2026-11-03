import { readFileSync } from "node:fs"
export interface Config {
  keyBudget: { resetHourUtc: number; thresholdsPercent: number[] }
  planningBudget?: { monthlyUsd: number }
  forecast: { windowMinutes: number; minSpanMinutes: number; criticalMinutes: number }
  session: { tiers: { minOutputPricePerMillion: number; stepUsd: number }[]; unpricedStepUsd: number }
  spike: { minSteps: number; multiplier: number; minStepUsd: number; cooldownMinutes: number }
  context: { thresholdsTokens: number[]; tierWarnFraction: number; criticalInputUsd: number; criticalWindowFraction: number; riskCooldownMinutes: number }
  cache: { minContextTokens: number; minReadRatio: number; consecutiveSteps: number }
  report: { activeWithinMinutes: number; topSessions: number; lastAlerts: number }
  litellm: { baseUrl: string; keyFile?: string; keyEnv: string; userAgent: string }
  models: { providerId: string; refreshMinutes: number }
  notify: { channels: NotifyChannel[]; webhookEnv: string }
  storage: { dir: string }
}

export type NotifyChannel = "system" | "webhook" | "stdout"
const CHANNELS: readonly string[] = ["system", "webhook", "stdout"]

type Obj = Record<string, unknown>

function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`config.${path}: expected object`)
  return value as Obj
}

function num(parent: Obj, key: string, path: string, min: number, max = Number.POSITIVE_INFINITY): number {
  const value = parent[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`config.${path}.${key}: expected number in [${min}, ${max}]`)
  }
  return value
}

function positiveNum(parent: Obj, key: string, path: string): number {
  const value = num(parent, key, path, 0)
  if (value === 0) throw new Error(`config.${path}.${key}: expected number greater than zero`)
  return value
}

function str(parent: Obj, key: string, path: string): string {
  const value = parent[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`config.${path}.${key}: expected non-empty string`)
  return value
}

function optStr(parent: Obj, key: string, path: string): string | undefined {
  return parent[key] === undefined ? undefined : str(parent, key, path)
}

function bool(parent: Obj, key: string, path: string): boolean {
  if (typeof parent[key] !== "boolean") throw new Error(`config.${path}.${key}: expected boolean`)
  return parent[key] as boolean
}

function numList(parent: Obj, key: string, path: string, min: number): number[] {
  const value = parent[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== "number" || !(x >= min))) {
    throw new Error(`config.${path}.${key}: expected non-empty array of numbers >= ${min}`)
  }
  return [...(value as number[])].sort((a, b) => a - b)
}

export function parseConfig(raw: unknown): Config {
  const root = obj(raw, "")
  const key = obj(root.keyBudget, "keyBudget")
  const forecast = obj(root.forecast, "forecast")
  const session = obj(root.session, "session")
  const spike = obj(root.spike, "spike")
  const context = obj(root.context, "context")
  const cache = obj(root.cache, "cache")
  const report = obj(root.report, "report")
  const litellm = obj(root.litellm, "litellm")
  const models = obj(root.models, "models")
  const notify = obj(root.notify, "notify")
  const storage = obj(root.storage, "storage")
  const planningBudget = Object.hasOwn(root, "planningBudget") ? obj(root.planningBudget, "planningBudget") : undefined
  if (!Array.isArray(notify.channels) || notify.channels.some((c) => typeof c !== "string" || !CHANNELS.includes(c))) {
    throw new Error(`config.notify.channels: expected array of ${CHANNELS.join(" | ")}`)
  }

  if (!Array.isArray(session.tiers) || session.tiers.length === 0) throw new Error("config.session.tiers: expected non-empty array")
  const tiers = session.tiers.map((tier, index) => {
    const t = obj(tier, `session.tiers[${index}]`)
    return {
      minOutputPricePerMillion: num(t, "minOutputPricePerMillion", `session.tiers[${index}]`, 0),
      stepUsd: num(t, "stepUsd", `session.tiers[${index}]`, 0.01),
    }
  })
  if (!tiers.some((t) => t.minOutputPricePerMillion === 0)) {
    throw new Error("config.session.tiers: one tier must have minOutputPricePerMillion = 0")
  }
  tiers.sort((a, b) => b.minOutputPricePerMillion - a.minOutputPricePerMillion)

  return {
    keyBudget: {
      resetHourUtc: num(key, "resetHourUtc", "keyBudget", 0, 23),
      thresholdsPercent: numList(key, "thresholdsPercent", "keyBudget", 1),
    },
    ...(planningBudget === undefined ? {} : {
      planningBudget: {
        monthlyUsd: positiveNum(planningBudget, "monthlyUsd", "planningBudget"),
      },
    }),
    forecast: {
      windowMinutes: num(forecast, "windowMinutes", "forecast", 1),
      minSpanMinutes: num(forecast, "minSpanMinutes", "forecast", 1),
      criticalMinutes: num(forecast, "criticalMinutes", "forecast", 1),
    },
    session: { tiers, unpricedStepUsd: num(session, "unpricedStepUsd", "session", 0.01) },
    spike: {
      minSteps: num(spike, "minSteps", "spike", 1),
      multiplier: num(spike, "multiplier", "spike", 1),
      minStepUsd: num(spike, "minStepUsd", "spike", 0),
      cooldownMinutes: num(spike, "cooldownMinutes", "spike", 1),
    },
    context: {
      thresholdsTokens: numList(context, "thresholdsTokens", "context", 1),
      tierWarnFraction: num(context, "tierWarnFraction", "context", 0.1, 1),
      // Миграция конфигов до Telegram: дефолты заданы только на границе конфигурации.
      criticalInputUsd: context.criticalInputUsd === undefined ? 0.1 : num(context, "criticalInputUsd", "context", 0.01),
      criticalWindowFraction: context.criticalWindowFraction === undefined ? 0.9 : num(context, "criticalWindowFraction", "context", 0.1, 1),
      riskCooldownMinutes: context.riskCooldownMinutes === undefined ? 10 : num(context, "riskCooldownMinutes", "context", 1),
    },
    cache: {
      minContextTokens: num(cache, "minContextTokens", "cache", 0),
      minReadRatio: num(cache, "minReadRatio", "cache", 0, 1),
      consecutiveSteps: num(cache, "consecutiveSteps", "cache", 1),
    },
    report: {
      activeWithinMinutes: num(report, "activeWithinMinutes", "report", 1),
      topSessions: num(report, "topSessions", "report", 1),
      lastAlerts: num(report, "lastAlerts", "report", 1),
    },
    litellm: {
      baseUrl: str(litellm, "baseUrl", "litellm").replace(/\/+$/, ""),
      keyFile: optStr(litellm, "keyFile", "litellm"),
      keyEnv: str(litellm, "keyEnv", "litellm"),
      userAgent: str(litellm, "userAgent", "litellm"),
    },
    models: { providerId: str(models, "providerId", "models"), refreshMinutes: num(models, "refreshMinutes", "models", 1) },
    notify: { channels: notify.channels as NotifyChannel[], webhookEnv: str(notify, "webhookEnv", "notify") },
    storage: { dir: str(storage, "dir", "storage") },
  }
}

/** Переменные окружения важнее файла: так один пакет работает у разных людей без правки конфига. */
export function loadConfigFile(path: string, env: Record<string, string | undefined> = process.env): Config {
  const cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")))
  if (env.LITELLM_BASE_URL) cfg.litellm.baseUrl = env.LITELLM_BASE_URL.replace(/\/+$/, "")
  if (env.LITELLM_SPEND_DIR) cfg.storage.dir = env.LITELLM_SPEND_DIR
  return cfg
}
