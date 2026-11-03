import { Plugin } from "@opencode/plugin/tui"
import { LitellmSpend } from "./rpc.ts"
import { mountSpendFooter } from "./footer.tsx"

export default Plugin.define({
  id: "litellm-spend.tui",
  setup(context) {
    return mountSpendFooter(context, context.client.rpc(LitellmSpend))
  },
})
