import { Rpc } from "@opencode/plugin/rpc"

export type AcpMode = "auto" | "accept-edits" | "default" | "plan"

export interface AcpSessionState {
  readonly sessionID: string
  readonly mode: AcpMode
  readonly codeModeEnabled: boolean
  readonly starting: boolean
  readonly acpSessionId: string | null
  readonly connected: boolean
  readonly busy: boolean
  readonly modelCount: number
  readonly relayedToolCount: number
  readonly lastError: string | null
  readonly cooldownUntil: number | null
}

const sessionIdSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const stateSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    mode: { type: "string", enum: ["auto", "accept-edits", "default", "plan"] },
    codeModeEnabled: { type: "boolean" },
    starting: { type: "boolean" },
    acpSessionId: { anyOf: [{ type: "string" }, { type: "null" }] },
    connected: { type: "boolean" },
    busy: { type: "boolean" },
    modelCount: { type: "number" },
    relayedToolCount: { type: "number" },
    lastError: { anyOf: [{ type: "string" }, { type: "null" }] },
    cooldownUntil: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: [
    "sessionID",
    "mode",
    "codeModeEnabled",
    "starting",
    "acpSessionId",
    "connected",
    "busy",
    "modelCount",
    "relayedToolCount",
    "lastError",
    "cooldownUntil",
  ],
  additionalProperties: false,
} as const

export const AcpRpc = Rpc.define({
  id: "antigravity-acp",
  methods: {
    getState: {
      input: sessionIdSchema,
      output: stateSchema,
    },
    setMode: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          mode: { type: "string", enum: ["auto", "accept-edits", "default", "plan"] },
        },
        required: ["sessionID", "mode"],
        additionalProperties: false,
      },
      output: stateSchema,
    },
    setCodeMode: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          codeModeEnabled: { type: "boolean" },
        },
        required: ["sessionID", "codeModeEnabled"],
        additionalProperties: false,
      },
      output: stateSchema,
    },
    resetSession: {
      input: sessionIdSchema,
      output: stateSchema,
    },
    warmSession: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: stateSchema,
    },
    reloadModels: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          modelCount: { type: "number" },
        },
        required: ["modelCount"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
