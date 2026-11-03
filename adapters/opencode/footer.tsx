import { createSignal } from "solid-js"

type KeySpend = { spend: number; maxBudget: number; updatedAt: number; estimated?: boolean; available?: boolean }

const usd = (value: number) => `$${value.toFixed(2)}`

export function mountSpendFooter(context: any, spend: any) {
  const [key, setKey] = createSignal<KeySpend | null>(null)

  void spend.get({}).then((result: { key: KeySpend | null }) => setKey(result.key))
  const stop = spend.events.on("updated", (event: { data: KeySpend }) => setKey(event.data))

  const unslot = context.ui.slot({
    append: "prompt.footer.status",
    render: () => {
      const current = key()
      if (!current) return null
      if (current.available === false) return <text fg={context.theme.text.muted}>key: локальная оценка пока недоступна</text>
      if (current.spend < 0) return <text fg={context.theme.text.muted}>{`key: LiteLLM сообщил отрицательный расход ${usd(current.spend)}`}</text>
      const left = current.maxBudget - current.spend
      return <text fg={context.theme.text.muted}>{`${current.estimated ? "key ≈" : "key"} ${usd(current.spend)} / ${usd(current.maxBudget)} · left ${usd(left)}`}</text>
    },
  })

  return () => {
    stop()
    unslot()
  }
}
