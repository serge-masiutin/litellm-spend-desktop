import { execFile } from "node:child_process"
import type { Config } from "./config.ts"
import type { AlertRecord } from "./store.ts"

export type Notifier = (alert: AlertRecord) => Promise<void>

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, (error) => (error ? reject(error) : resolve())))
}

function systemNotify(alert: AlertRecord): Promise<void> {
  if (process.platform === "darwin") {
    const sound = alert.severity === "critical" ? ' sound name "Basso"' : ""
    const script = ["on run argv", `display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)${sound}`, "end run"]
    return run("osascript", script.flatMap((line) => ["-e", line]).concat(["--", alert.body, alert.title, alert.subtitle ?? ""]))
  }
  if (process.platform === "linux") return run("notify-send", [alert.title, [alert.subtitle, alert.body].filter(Boolean).join("\n")])
  return Promise.reject(new Error(`system notifications are not supported on ${process.platform}`))
}

async function webhookNotify(url: string, alert: AlertRecord): Promise<void> {
  const text = [`*${alert.title}*`, alert.subtitle, alert.body].filter(Boolean).join("\n")
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...alert }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`webhook: HTTP ${response.status}`)
}

/** Сбой одного канала не мешает остальным: оповещение остаётся в журнале в любом случае. */
export function createNotifier(cfg: () => Config["notify"], env: Record<string, string | undefined>, log: (message: string) => void): Notifier {
  return async (alert) => {
    const { channels, webhookEnv } = cfg()
    await Promise.all(
      channels.map(async (channel) => {
        try {
          if (channel === "system") await systemNotify(alert)
          else if (channel === "stdout") console.log(`[${alert.severity}] ${alert.title}${alert.subtitle ? ` — ${alert.subtitle}` : ""}: ${alert.body}`)
          else {
            const url = env[webhookEnv]
            if (!url) throw new Error(`webhook channel enabled but ${webhookEnv} is not set`)
            await webhookNotify(url, alert)
          }
        } catch (error) {
          log(`notification via ${channel} failed: ${String(error)}`)
        }
      }),
    )
  }
}
