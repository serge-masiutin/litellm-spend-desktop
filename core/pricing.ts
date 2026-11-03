import type { ModelRow } from "./litellm.ts"
import type { Tokens } from "./rules.ts"

const PER_MILLION = 1_000_000
const TIER_KEY = /^input_cost_per_token_above_(\d+)k_tokens$/

/** Цены за 1M токенов. fromTokens — размер контекста, выше которого действует уровень; у базового уровня null. */
export interface PriceTier {
  fromTokens: number | null
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

export interface ModelSpec {
  id: string
  mode: string | null
  /** Входные форматы из флагов supports_* LiteLLM: text всегда, остальные по наличию флага. */
  inputs: string[]
  contextLimit?: number
  outputLimit?: number
  tiers: PriceTier[]
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function perMillion(value: number | null): number | null {
  return value === null ? null : Number((value * PER_MILLION).toFixed(6))
}

function tiersOf(info: Record<string, unknown>): PriceTier[] | null {
  const input = num(info.input_cost_per_token)
  const output = num(info.output_cost_per_token)
  if (input === null || output === null) return null
  const base: PriceTier = {
    fromTokens: null,
    input: perMillion(input)!,
    output: perMillion(output)!,
    cacheRead: perMillion(num(info.cache_read_input_token_cost)),
    cacheWrite: perMillion(num(info.cache_creation_input_token_cost)),
  }
  const tiers = [base]
  for (const key of Object.keys(info)) {
    const match = TIER_KEY.exec(key)
    const tierInput = match === null ? null : num(info[key])
    if (match === null || tierInput === null) continue
    const suffix = `above_${match[1]}k_tokens`
    tiers.push({
      fromTokens: Number(match[1]) * 1000,
      input: perMillion(tierInput)!,
      output: perMillion(num(info[`output_cost_per_token_${suffix}`])) ?? base.output,
      cacheRead: perMillion(num(info[`cache_read_input_token_cost_${suffix}`])) ?? base.cacheRead,
      cacheWrite: perMillion(num(info[`cache_creation_input_token_cost_${suffix}`])) ?? base.cacheWrite,
    })
  }
  return tiers.sort((a, b) => (a.fromTokens ?? 0) - (b.fromTokens ?? 0))
}

/**
 * У модели в LiteLLM может быть несколько деплойментов с разной ценой (прямой и Bedrock).
 * Берём основной: с наименьшим order, при равенстве — дешёвый.
 */
export function buildModelSpecs(rows: ModelRow[]): Map<string, ModelSpec> {
  const byName = new Map<string, ModelRow[]>()
  for (const row of rows) byName.set(row.model_name, [...(byName.get(row.model_name) ?? []), row])
  const specs = new Map<string, ModelSpec>()
  for (const [id, deployments] of byName) {
    const ranked = [...deployments].sort(
      (a, b) => (a.litellm_params?.order ?? 99) - (b.litellm_params?.order ?? 99) || (num(a.model_info.input_cost_per_token) ?? Infinity) - (num(b.model_info.input_cost_per_token) ?? Infinity),
    )
    const priced = ranked.find((row) => tiersOf(row.model_info) !== null)
    const info = (priced ?? ranked[0]).model_info
    specs.set(id, {
      id,
      mode: typeof info.mode === "string" ? info.mode : null,
      inputs: [
        "text",
        ...(info.supports_vision === true ? ["image"] : []),
        ...(info.supports_pdf_input === true ? ["pdf"] : []),
        ...(info.supports_audio_input === true ? ["audio"] : []),
      ],
      contextLimit: num(info.max_input_tokens) ?? undefined,
      outputLimit: num(info.max_output_tokens) ?? undefined,
      tiers: priced === undefined ? [] : tiersOf(priced.model_info)!,
    })
  }
  return specs
}

/**
 * Цена одного шага по ценам LiteLLM. Токены размышления тарифицируются как выходные.
 * Кеш без собственной цены считается по цене входа.
 */
export function stepCost(tokens: Tokens, spec: ModelSpec): number | null {
  const parts = stepCharges(tokens, spec)
  return parts === null ? null : parts.inputUsd + parts.outputUsd
}

export interface StepCharges {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
}

/** Реальная повторная плата за вход, включая чтение и запись кеша; не гипотетическая цена без кеша. */
export function stepCharges(tokens: Tokens, spec: ModelSpec): StepCharges | null {
  if (spec.tiers.length === 0) return null
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const tier = [...spec.tiers].reverse().find((candidate) => candidate.fromTokens === null || context > candidate.fromTokens)!
  const cacheReadUsd = tokens.cache.read * (tier.cacheRead ?? tier.input) / PER_MILLION
  const cacheWriteUsd = tokens.cache.write * (tier.cacheWrite ?? tier.input) / PER_MILLION
  return {
    inputUsd: tokens.input * tier.input / PER_MILLION + cacheReadUsd + cacheWriteUsd,
    outputUsd: (tokens.output + tokens.reasoning) * tier.output / PER_MILLION,
    cacheReadUsd,
    cacheWriteUsd,
  }
}

const NON_CHAT_MODES = new Set(["embedding", "image_generation", "audio_transcription", "audio_speech", "rerank", "moderation"])

/** Чат-модель — всё, что не относится к явно нечатовым режимам; у роутеров режима нет. */
export function isChatModel(spec: ModelSpec): boolean {
  return spec.mode === null || !NON_CHAT_MODES.has(spec.mode)
}
