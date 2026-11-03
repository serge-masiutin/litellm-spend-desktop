import { join } from "node:path"
import { ModelCatalog } from "./catalog.ts"
import { loadConfigFile } from "./config.ts"
import { LitellmClient, resolveApiKey } from "./litellm.ts"
import { catalogFile, Monitor, openStore } from "./monitor.ts"
import { createNotifier } from "./notify.ts"

export interface Runtime {
  monitor: Monitor
  catalog: ModelCatalog
  client: LitellmClient | null
}

/**
 * Собирает мониторинг из config.json. Ключ нужен только для каталога моделей и цен:
 * без него цены берутся из кеша. Серверный расход приходит из заголовков агента,
 * локальная оценка — из его шагов и ручных поправок.
 */
export function createRuntime(configPath: string, env: Record<string, string | undefined> = process.env): Runtime {
  const cfg = loadConfigFile(configPath, env)
  const store = openStore(cfg)
  let client: LitellmClient | null = null
  try {
    client = new LitellmClient(cfg.litellm.baseUrl, resolveApiKey(cfg.litellm, env), cfg.litellm.userAgent)
  } catch (error) {
    store.log(`LiteLLM client disabled: ${String(error)}`)
  }
  const catalog: ModelCatalog = new ModelCatalog(client, catalogFile(cfg), () => monitor.cfg.models.refreshMinutes)
  const notifier = createNotifier(() => monitor.cfg.notify, env, (message) => store.log(message))
  const monitor: Monitor = new Monitor(configPath, catalog, notifier, cfg, store)
  return { monitor, catalog, client }
}

export const defaultConfigPath = (dir: string) => join(dir, "config.json")
