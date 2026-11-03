import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { Config } from "./config.ts"

export interface ModelRow {
  model_name: string
  litellm_params?: { order?: number }
  model_info: Record<string, unknown>
}

export interface KeyReading {
  spend: number
  maxBudget: number
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path
}

export function resolveApiKey(cfg: Config["litellm"], env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[cfg.keyEnv]?.trim()
  if (fromEnv) return fromEnv
  if (cfg.keyFile !== undefined) {
    const fromFile = readFileSync(expandHome(cfg.keyFile), "utf8").trim()
    if (fromFile) return fromFile
  }
  throw new Error(`LiteLLM API key not found: set ${cfg.keyEnv} or litellm.keyFile`)
}

/** Сохраняем счётчик шлюза; отрицательный расход вне машинной погрешности — аномалия. */
export function parseKeyHeaders(headers: { get(name: string): string | null }): KeyReading | null {
  const rawSpend = headers.get("x-litellm-key-spend")
  const rawBudget = headers.get("x-litellm-key-max-budget")
  if (rawSpend === null || rawBudget === null || rawSpend.trim() === "" || rawBudget.trim() === "") return null
  const spend = Number(rawSpend)
  const maxBudget = Number(rawBudget)
  if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) return null
  // Вычитание бюджета при сбросе может оставить отрицательный хвост около нуля.
  // Допуск масштабируется точностью Double относительно лимита, а не округлением до центов.
  const zeroTolerance = Number.EPSILON * Math.max(1, maxBudget)
  return { spend: spend <= 0 && spend >= -zeroTolerance ? 0 : spend, maxBudget }
}

export class LitellmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly userAgent: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, Authorization: `Bearer ${this.apiKey}`, "User-Agent": this.userAgent },
    })
    // Редирект на страницу входа означает, что путь закрыт шлюзом доступа, а не что ключ неверный
    if (response.status >= 300 && response.status < 400) throw new Error(`LiteLLM ${path}: blocked by access gateway (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`LiteLLM ${path}: HTTP ${response.status}`)
    return response
  }

  async modelInfo(): Promise<ModelRow[]> {
    const body = (await (await this.request("/v1/model/info")).json()) as { data?: ModelRow[] }
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("LiteLLM /v1/model/info: empty model list")
    return body.data
  }
}
