import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { LitellmClient } from "./litellm.ts"
import { buildModelSpecs, type ModelSpec } from "./pricing.ts"

/** Каталог моделей и цен из LiteLLM. Файл-кеш общий для всех процессов, поэтому шлюз опрашивается не чаще одного раза за период. */
/** Меняйте при изменении формата ModelSpec: кеш другой версии игнорируется и запрашивается заново. */
const CACHE_VERSION = 2

export class ModelCatalog {
  private specs = new Map<string, ModelSpec>()
  private fingerprint = ""
  private cacheStale = false

  constructor(
    private readonly client: LitellmClient | null,
    private readonly file: string,
    private readonly refreshMinutes: () => number,
  ) {}

  get(id: string): ModelSpec | undefined {
    return this.specs.get(id)
  }

  all(): ModelSpec[] {
    return [...this.specs.values()]
  }

  private load(): boolean {
    this.cacheStale = false
    let text: string
    try {
      text = readFileSync(this.file, "utf8")
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false
      throw error
    }
    const parsed = JSON.parse(text) as { version?: number; specs: ModelSpec[] }
    if (parsed.version !== CACHE_VERSION) {
      this.cacheStale = true
      return false
    }
    this.specs = new Map(parsed.specs.map((spec) => [spec.id, spec]))
    const next = JSON.stringify(parsed.specs)
    const changed = next !== this.fingerprint
    this.fingerprint = next
    return changed
  }

  /** Возвращает true, если набор цен изменился с прошлого вызова. */
  async refresh(force = false): Promise<boolean> {
    let ageMs = Infinity
    try {
      ageMs = Date.now() - statSync(this.file).mtimeMs
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error
    }
    if (!force && ageMs < this.refreshMinutes() * 60_000) {
      const changed = this.load()
      if (!this.cacheStale) return changed
    }
    if (this.client === null) {
      if (this.cacheStale) throw new Error("model cache has an old format and there is no LiteLLM key to refresh it")
      return this.load()
    }
    const specs = [...buildModelSpecs(await this.client.modelInfo()).values()]
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, fetchedAt: Date.now(), specs }))
    renameSync(temp, this.file)
    return this.load()
  }
}
