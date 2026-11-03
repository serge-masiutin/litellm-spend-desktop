import { Rpc } from "@opencode/plugin/rpc"

const keySpend = {
  type: "object",
  properties: {
    spend: { type: "number" },
    maxBudget: { type: "number" },
    updatedAt: { type: "number" },
    estimated: { type: "boolean" },
    available: { type: "boolean" },
  },
  required: ["spend", "maxBudget", "updatedAt"],
  additionalProperties: false,
} as const

export const LitellmSpend = Rpc.define({
  id: "litellm-spend",
  methods: {
    get: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { key: { anyOf: [keySpend, { type: "null" }] } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: { schema: keySpend },
  },
})
