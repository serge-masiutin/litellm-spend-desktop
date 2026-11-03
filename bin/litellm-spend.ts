#!/usr/bin/env bun
/**
 * Автономный запуск мониторинга LiteLLM без привязки к агенту.
 *   litellm-spend watch            держать каталог цен свежим
 *   litellm-spend status           остаток ключа и темп по последним данным агентов
 *   litellm-spend report           полная сводка в текст
 *   litellm-spend models           цены моделей из LiteLLM (--json для машинного вывода)
 *   litellm-spend ingest           принять шаг сессии из stdin (JSON, формат StepEvent) от любого агента
 *   litellm-spend ingest-key       принять расход ключа из stdin: {"spend": 12.5, "maxBudget": 200} или {"headers": {...}} из ответа LiteLLM
 * Конфиг: --config <путь> или LITELLM_SPEND_CONFIG, по умолчанию config.json рядом с пакетом.
 */
import { fileURLToPath } from "node:url"
import { formatReport, formatShort, usd } from "../core/format.ts"
import { createRuntime } from "../core/runtime.ts"
import { parseKeyHeaders } from "../core/litellm.ts"
import type { StepEvent } from "../core/monitor.ts"

const args = process.argv.slice(2)
const command = args[0] ?? "help"
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const configPath = flag("--config") ?? process.env.LITELLM_SPEND_CONFIG ?? fileURLToPath(new URL("../config.json", import.meta.url))

function validateStep(raw: unknown): StepEvent {
  const e = raw as StepEvent
  const tokens = e?.tokens
  if (
    typeof e?.id !== "string" || typeof e.sessionId !== "string" || typeof e.at !== "number" ||
    typeof e.model?.id !== "string" || typeof tokens?.input !== "number" || typeof tokens.output !== "number" ||
    typeof tokens.reasoning !== "number" || typeof tokens.cache?.read !== "number" || typeof tokens.cache?.write !== "number"
  ) {
    throw new Error("ingest: expected { id, at, sessionId, sessionTitle, directory, model: { id }, tokens: { input, output, reasoning, cache: { read, write } } }")
  }
  if (e.ancestorIds !== undefined && (!Array.isArray(e.ancestorIds) || e.ancestorIds.length > 100 || e.ancestorIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id === e.sessionId) || new Set(e.ancestorIds).size !== e.ancestorIds.length)) {
    throw new Error("ingest: ancestorIds must be a unique array of valid ancestor session IDs")
  }
  if (e.ancestryComplete !== undefined && typeof e.ancestryComplete !== "boolean") throw new Error("ingest: ancestryComplete must be boolean")
  return { ...e, sessionTitle: e.sessionTitle ?? "", directory: e.directory ?? "" }
}

async function main(): Promise<void> {
  if (command === "telegram") {
    const { telegramCli } = await import("../adapters/telegram/cli.ts")
    await telegramCli(configPath, args[1] ?? "help")
    return
  }
  if (command === "help" || command === "--help") {
    console.log("usage: litellm-spend <watch|status|report|models|ingest|ingest-key|telegram|correct-day YYYY-MM-DD USD> [--config path]")
    return
  }
  const { monitor, catalog } = createRuntime(configPath)
  if (command === "correct-day") {
    if (args[1] === undefined || args[2] === undefined || !/^\d+(?:\.\d+)?$/.test(args[2])) throw new Error("Использование: correct-day YYYY-MM-DD USD (итог дня на текущий момент)")
    await monitor.correctDailyBudget(args[1], Number(args[2]))
    console.log(`Расход за ${args[1]} UTC исправлен: ${usd(Number(args[2]))}. Новые шаги прибавляются к этому итогу.`)
    return
  }
  await catalog.refresh(command === "models" && args.includes("--refresh"))

  if (command === "watch") {
    console.log(`watching model prices every ${monitor.cfg.models.refreshMinutes} min, storage ${monitor.store.dir}`)
    setInterval(() => void catalog.refresh().catch((error) => {
      monitor.store.log(`catalog refresh failed: ${String(error)}`)
      console.error(String(error))
    }), 60_000)
    return
  }
  if (command === "status") {
    const now = Date.now()
    console.log(formatShort(monitor.currentKeyView(now), now, monitor.currentMonthlyEstimate(now), monitor.cfg.planningBudget))
    return
  }
  if (command === "report") {
    const sessions = monitor.store.listSessions()
    const now = Date.now()
    console.log(formatReport({ key: monitor.currentKeyView(now), monthly: monitor.currentMonthlyEstimate(now), sessions: sessions.records, corrupt: sessions.corrupt, alerts: monitor.store.readAlerts(monitor.cfg.report.lastAlerts), nowMs: now, cfg: monitor.cfg }))
    return
  }
  if (command === "models") {
    const rows = catalog.all().filter((spec) => spec.tiers.length > 0).sort((a, b) => a.id.localeCompare(b.id))
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2))
    else for (const spec of rows) console.log(`${spec.id.padEnd(32)} in ${usd(spec.tiers[0].input).padStart(7)}  out ${usd(spec.tiers[0].output).padStart(7)} за 1M, контекст ${spec.contextLimit ?? "?"}`)
    return
  }
  if (command === "ingest") {
    const step = validateStep(JSON.parse(await Bun.stdin.text()))
    await monitor.onStep(step)
    return
  }
  if (command === "ingest-key") {
    const input = JSON.parse(await Bun.stdin.text()) as { spend?: unknown; maxBudget?: unknown; headers?: Record<string, string> }
    const lower = Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    const reading =
      input.headers === undefined
        ? { spend: input.spend, maxBudget: input.maxBudget }
        : parseKeyHeaders({ get: (name) => lower[name] ?? null })
    if (reading === null || typeof reading.spend !== "number" || typeof reading.maxBudget !== "number" || !(reading.maxBudget > 0)) {
      throw new Error('ingest-key: expected {"spend": number, "maxBudget": number} or {"headers": {"x-litellm-key-spend": ..., "x-litellm-key-max-budget": ...}}')
    }
    await monitor.onKeySample(reading.spend, reading.maxBudget)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

main().catch((error) => {
  console.error(String(error))
  process.exit(1)
})
