#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"

// У собранного CLI import.meta.url относится к ресурсам .app, а не к пользовательскому конфигу.
process.env.LITELLM_SPEND_CONFIG ??= join(homedir(), ".config/opencode/plugins/litellm-spend/config.json")
await import("./litellm-spend.ts")
