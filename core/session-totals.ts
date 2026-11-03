import type { SessionRecord } from "./store.ts"

/** Каждая собственная стоимость прибавляется к каждому известному предку ровно один раз. */
export function sessionTotals(sessions: SessionRecord[]): Map<string, { cost: number; descendants: number }> {
  const totals = new Map(sessions.map((session) => [session.id, { cost: session.cost, descendants: 0 }]))
  for (const session of sessions) {
    for (const ancestor of new Set(session.ancestorIds ?? [])) {
      if (ancestor === session.id) continue
      const total = totals.get(ancestor)
      if (total === undefined) continue
      total.cost += session.cost
      total.descendants++
    }
  }
  return totals
}
