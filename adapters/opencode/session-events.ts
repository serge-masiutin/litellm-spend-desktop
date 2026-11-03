import type { Monitor } from "../../core/monitor.ts"
import type { Tokens } from "../../core/rules.ts"

interface ModelRef { providerID: string; id: string; variant?: string }
export interface SessionEvent {
  type: string
  id: string
  created: number
  data: {
    sessionID: string
    assistantMessageID?: string
    model?: ModelRef
    cost?: number
    tokens?: Tokens
  }
}

interface SessionReader {
  get(input: { sessionID: string }): Promise<{ title?: string; parentID?: string; location: { directory: string } }>
  context?(input: { sessionID: string }): Promise<readonly { id: string; type: string; model?: ModelRef }[]>
}

/** Отбирает шаги по провайдеру, а не имени модели. Общие итоги OpenCode намеренно не используются. */
export class SessionEvents {
  private readonly steps = new Map<string, { sessionID: string; model: ModelRef }>()
  private readonly ancestry = new Map<string, string[]>()

  constructor(
    private readonly providerID: string,
    private readonly monitor: Pick<Monitor, "store" | "onStep">,
    private readonly sessions: SessionReader,
  ) {}

  async handle(event: SessionEvent): Promise<void> {
    const { store } = this.monitor
    const { sessionID } = event.data
    if (event.type === "session.step.started") {
      const { model, assistantMessageID } = event.data
      if (model === undefined || assistantMessageID === undefined) throw new Error("step.started: missing model or message id")
      this.steps.set(assistantMessageID, { sessionID, model })
      if (model.providerID === this.providerID) store.markRunning(sessionID)
      else store.clearRunning(sessionID)
      return
    }
    // До первого шага провайдер неизвестен: execution.started не означает активность LiteLLM.
    if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) {
      store.clearRunning(sessionID)
      for (const [id, step] of this.steps) if (step.sessionID === sessionID) this.steps.delete(id)
      return
    }
    if (event.type !== "session.step.ended") return
    const { assistantMessageID } = event.data
    if (assistantMessageID === undefined) throw new Error("step.ended: missing message id")
    let step = this.steps.get(assistantMessageID)
    if (step === undefined && this.sessions.context !== undefined) {
      // После reload начало шага мог видеть предыдущий runtime. Читаем именно его сообщение,
      // а не текущий выбор модели: он мог смениться и принадлежать другому провайдеру.
      const messages = await this.sessions.context({ sessionID })
      const message = messages.find((message) => message.id === assistantMessageID && message.type === "assistant")
      if (message?.model !== undefined) step = { sessionID, model: message.model }
    }
    if (step === undefined) throw new Error(`no model recorded for step ${assistantMessageID}`)
    this.steps.delete(assistantMessageID)
    if (step.sessionID !== sessionID) throw new Error("step session mismatch")
    if (step.model.providerID !== this.providerID) return
    const { tokens, cost } = event.data
    if (tokens === undefined || cost === undefined) throw new Error("step.ended: missing tokens or cost")
    const session = await this.sessions.get({ sessionID })
    const ancestry = await this.ancestors(sessionID, session.parentID)
    await this.monitor.onStep({
      id: event.id,
      at: event.created,
      sessionId: sessionID,
      sessionTitle: session.title ?? "",
      directory: session.location.directory,
      ...ancestry,
      model: { id: step.model.id, variant: step.model.variant },
      tokens,
      reportedStepCost: cost,
    })
  }

  private async ancestors(sessionID: string, parentID: string | undefined): Promise<{ ancestorIds: string[]; ancestryComplete: boolean }> {
    const cached = this.ancestry.get(sessionID)
    if (cached !== undefined) return { ancestorIds: cached, ancestryComplete: true }
    const ancestors: string[] = []
    const visited = new Set([sessionID])
    let current = parentID
    while (current !== undefined) {
      if (visited.has(current) || ancestors.length >= 100) {
        this.monitor.store.log("session ancestry invalid: cycle or excessive depth")
        return { ancestorIds: ancestors, ancestryComplete: false }
      }
      visited.add(current)
      ancestors.push(current)
      try {
        current = (await this.sessions.get({ sessionID: current })).parentID
      } catch (error) {
        this.monitor.store.log(`session ancestry unavailable: ${String(error)}`)
        return { ancestorIds: ancestors, ancestryComplete: false }
      }
    }
    this.ancestry.set(sessionID, ancestors)
    return { ancestorIds: ancestors, ancestryComplete: true }
  }
}
