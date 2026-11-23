import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import {
  AcpProcess,
  AgyNotFoundError,
  FALLBACK_MODELS,
  buildModelCatalog,
  discoverAcpModels,
  resolveAcpModelTarget,
  type AcpDiscoveredModel,
  type AcpPermissionOutcome,
  type AcpPermissionRequestParams,
  type AcpPromptResult,
  type AcpSessionUpdate,
} from "./acp-client.js"
import {
  ACP_PROVIDER_ID,
  API_ERROR_ABORT_PATTERN,
  UNSAFE_INTERNAL_SIGNATURE,
  buildAcpPromptBlocks,
  extractToolResultsFromPrompt,
  isSyntheticRestartAfterError,
} from "./history-sanitizer.js"
import { McpRelayServer, type McpCallToolResult, type McpToolDescriptor } from "./mcp-relay.js"

export type AcpMode = "auto" | "accept-edits" | "default" | "plan"

class PluginDisposedError extends Error {
  constructor() {
    super("Antigravity ACP plugin instance was disposed")
    this.name = "PluginDisposedError"
  }
}

const NATIVE_SHADOWED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "grep",
  "glob",
  "ls",
  "list",
])

export interface SessionContextSnapshot {
  readonly systemText: string
  readonly agent: string
  readonly toolSignature: string
  readonly tools: Record<string, { readonly description: string; readonly input: any }>
  readonly mcpSafeToOriginal: Map<string, string>
  readonly mcpDescriptors: McpToolDescriptor[]
}

export interface SessionPublicState {
  readonly sessionID: string
  readonly mode: AcpMode
  readonly relayAllTools: boolean
  readonly acpSessionId: string | null
  readonly connected: boolean
  readonly busy: boolean
  readonly modelCount: number
  readonly relayedToolCount: number
  readonly lastError: string | null
  readonly cooldownUntil: number | null
}

interface PendingMcpCall {
  readonly toolCallId: string
  readonly mcpName: string
  readonly openCodeToolName: string
  readonly args: unknown
  emittedToOpenCode: boolean
  resolved: boolean
  readonly resolve: (res: McpCallToolResult) => void
}

interface ActiveTurn {
  controller?: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  controllerCleanup?: () => void
  readonly bufferedParts: LanguageModelV3StreamPart[]
  openTextId?: string
  openReasoningId?: string
  partSeq: number
  readonly activeNativeTools: Map<string, string>
  readonly relayedUpdateIds: Set<string>
  readonly pendingMcpCalls: Map<string, PendingMcpCall>
  readonly dispatchedCallIds: Set<string>
  flushTimer?: ReturnType<typeof setTimeout>
  promptSettled: boolean
  abortedOnApiError?: boolean
  promptResult?: AcpPromptResult
  promptError?: Error
}

interface BridgeSession {
  readonly sessionID: string
  cwd: string
  mode: AcpMode
  relayAllTools: boolean
  acpSessionId?: string
  proc?: AcpProcess
  lastModelId?: string
  lastModeApplied?: AcpMode
  lastError: string | null
  lastTitleSent?: string
  needsReplayHistory?: boolean
  contextSnapshot?: SessionContextSnapshot
  activeTurn?: ActiveTurn
  startLock?: Promise<void>
  lastContextUsed?: number
}

const STORAGE_KEY_PREFIX = "antigravity-acp:session:"
const COOLDOWN_STORAGE_KEY = "antigravity-acp:cooldown"
const MODEL_CATALOG_STORAGE_KEY = "antigravity-acp:model-catalog:v1"
const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000

let sharedCatalog: readonly AcpDiscoveredModel[] | undefined
let sharedCatalogUpdatedAt = 0
let sharedDiscoveryPromise: Promise<readonly AcpDiscoveredModel[]> | undefined

export function resetSharedCatalogForTests(): void {
  sharedCatalog = undefined
  sharedCatalogUpdatedAt = 0
  sharedDiscoveryPromise = undefined
}

function isValidCatalog(raw: unknown): raw is readonly AcpDiscoveredModel[] {
  if (!Array.isArray(raw) || raw.length === 0) return false
  return raw.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof (item as any).id === "string" &&
      typeof (item as any).name === "string" &&
      typeof (item as any).defaultAcpModelId === "string" &&
      Array.isArray((item as any).variants),
  )
}

function normalizeCatalog(models: readonly AcpDiscoveredModel[]): readonly AcpDiscoveredModel[] {
  return models.map((m) => ({
    ...m,
    family: m.family || m.id,
  }))
}

function catalogSignature(models: readonly AcpDiscoveredModel[]): string {
  return JSON.stringify(models.map((m) => [m.id, m.name, m.family, m.defaultAcpModelId, m.variants]))
}

function zeroUsage(
  raw?: AcpPromptResult["usage"],
  activeContextUsed?: number,
): LanguageModelV3Usage {
  const inputTotal = activeContextUsed !== undefined ? activeContextUsed : raw?.inputTokens
  const cacheRead =
    raw?.cachedReadTokens !== undefined && inputTotal !== undefined
      ? Math.min(raw.cachedReadTokens, inputTotal)
      : raw?.cachedReadTokens
  const cacheWrite =
    raw?.cachedWriteTokens !== undefined && inputTotal !== undefined
      ? Math.min(raw.cachedWriteTokens, Math.max(0, inputTotal - (cacheRead ?? 0)))
      : raw?.cachedWriteTokens
  const outputTotal = raw?.outputTokens
  const reasoning = raw?.thoughtTokens
  const noCache =
    inputTotal !== undefined
      ? Math.max(0, inputTotal - (cacheRead ?? 0) - (cacheWrite ?? 0))
      : undefined
  const text =
    outputTotal !== undefined ? Math.max(0, outputTotal - (reasoning ?? 0)) : undefined
  return {
    inputTokens: {
      total: inputTotal,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: outputTotal,
      text,
      reasoning,
    },
  }
}

function sanitizeMcpToolName(name: string, used: Set<string>): string {
  let base = name.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (!base) base = "tool"
  let candidate = base
  let n = 2
  while (used.has(candidate)) {
    candidate = `${base}_${n++}`
  }
  used.add(candidate)
  return candidate
}

function buildDescriptors(
  tools: Record<string, { readonly description: string; readonly input: any }>,
  relayAllTools: boolean,
): { mcpDescriptors: McpToolDescriptor[]; mcpSafeToOriginal: Map<string, string> } {
  const used = new Set<string>()
  const mcpSafeToOriginal = new Map<string, string>()
  const mcpDescriptors: McpToolDescriptor[] = []

  for (const [toolName, info] of Object.entries(tools)) {
    if (toolName === ACP_PROVIDER_ID) continue
    if (!relayAllTools && NATIVE_SHADOWED_TOOLS.has(toolName)) continue
    const safeName = sanitizeMcpToolName(toolName, used)
    mcpSafeToOriginal.set(safeName, toolName)
    mcpDescriptors.push({
      name: safeName,
      description: info.description || `OpenCode tool: ${toolName}`,
      inputSchema: info.input,
    })
  }
  return { mcpDescriptors, mcpSafeToOriginal }
}

function extractToolContentText(update: AcpSessionUpdate): unknown {
  if (update.rawOutput !== undefined) return update.rawOutput
  if (Array.isArray(update.content)) {
    const texts: string[] = []
    for (const block of update.content as any[]) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text)
      else if (block?.content?.type === "text" && typeof block.content.text === "string") {
        texts.push(block.content.text)
      } else {
        texts.push(JSON.stringify(block))
      }
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return { status: update.status ?? "completed", title: update.title }
}

export class SessionBridgeManager {
  readonly mcpRelay: McpRelayServer
  private sessions = new Map<string, BridgeSession>()
  private catalog: readonly AcpDiscoveredModel[] = FALLBACK_MODELS
  private onStateChanged?: (sessionID: string) => void
  private onCatalogChanged?: () => void
  private discoverModelsFn: (cwd: string) => Promise<readonly AcpDiscoveredModel[]>
  private circuitBrokenUntil = 0
  private circuitReason: string | null = null
  private cooldownLoaded = false
  private disposed = false
  private activeProcs = new Set<AcpProcess>()
  private intentionallyDisposed = new WeakSet<AcpProcess>()

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly defaultCwd: string,
    onStateChanged?: (sessionID: string) => void,
    options?: {
      readonly onCatalogChanged?: () => void
      readonly discoverModels?: (cwd: string) => Promise<readonly AcpDiscoveredModel[]>
    },
  ) {
    this.onStateChanged = onStateChanged
    this.onCatalogChanged = options?.onCatalogChanged
    this.discoverModelsFn = options?.discoverModels ?? ((cwd) => discoverAcpModels(cwd))
    if (sharedCatalog && sharedCatalog.length > 0) {
      this.catalog = sharedCatalog
    }
    this.mcpRelay = new McpRelayServer({
      getTools: (sessionID) => {
        const s = this.sessions.get(sessionID)
        return s?.contextSnapshot?.mcpDescriptors ?? []
      },
      callTool: (sessionID, toolName, args, signal) =>
        this.handleIncomingMcpCall(sessionID, toolName, args, signal),
    })
  }

  async start(): Promise<void> {
    await this.mcpRelay.start()
  }

  getModels(): readonly AcpDiscoveredModel[] {
    return this.catalog
  }

  async loadCachedModels(): Promise<{ readonly stale: boolean; readonly changed: boolean }> {
    if (sharedCatalog && sharedCatalog.length > 0) {
      const prevSig = catalogSignature(this.catalog)
      this.catalog = sharedCatalog
      return {
        stale: Date.now() - sharedCatalogUpdatedAt > MODEL_CATALOG_TTL_MS,
        changed: prevSig !== catalogSignature(sharedCatalog),
      }
    }

    try {
      const raw = (await Effect.runPromise(
        this.ctx.storage.get(MODEL_CATALOG_STORAGE_KEY),
      )) as { readonly updatedAt?: unknown; readonly models?: unknown } | undefined
      if (raw && typeof raw === "object" && isValidCatalog(raw.models)) {
        const normalized = normalizeCatalog(raw.models)
        const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0
        const prevSig = catalogSignature(this.catalog)
        sharedCatalog = normalized
        sharedCatalogUpdatedAt = updatedAt
        this.catalog = normalized
        return {
          stale: Date.now() - updatedAt > MODEL_CATALOG_TTL_MS,
          changed: prevSig !== catalogSignature(normalized),
        }
      }
    } catch {}

    return { stale: true, changed: false }
  }

  private async persistCatalog(
    models: readonly AcpDiscoveredModel[],
    updatedAt: number,
  ): Promise<void> {
    try {
      await Effect.runPromise(
        this.ctx.storage.set(MODEL_CATALOG_STORAGE_KEY, {
          version: 1,
          updatedAt,
          models: models as unknown as any,
        }),
      )
    } catch {}
  }

  async refreshModels(options?: {
    readonly force?: boolean
  }): Promise<{ readonly models: readonly AcpDiscoveredModel[]; readonly changed: boolean }> {
    if (
      !options?.force &&
      sharedCatalog &&
      sharedCatalog.length > 0 &&
      Date.now() - sharedCatalogUpdatedAt <= MODEL_CATALOG_TTL_MS
    ) {
      const changed = catalogSignature(this.catalog) !== catalogSignature(sharedCatalog)
      this.catalog = sharedCatalog
      return { models: this.catalog, changed }
    }

    if (!sharedDiscoveryPromise) {
      sharedDiscoveryPromise = (async () => {
        const discovered = await this.discoverModelsFn(this.defaultCwd)
        const normalized = normalizeCatalog(discovered)
        if (normalized.length > 0) {
          const updatedAt = Date.now()
          sharedCatalog = normalized
          sharedCatalogUpdatedAt = updatedAt
          await this.persistCatalog(normalized, updatedAt)
        }
        return normalized
      })().finally(() => {
        sharedDiscoveryPromise = undefined
      })
    }

    const normalized = await sharedDiscoveryPromise
    if (normalized.length === 0) {
      return { models: this.catalog, changed: false }
    }

    const prevSig = catalogSignature(this.catalog)
    this.catalog = normalized
    const changed = prevSig !== catalogSignature(normalized)
    return { models: normalized, changed }
  }

  async refreshModelsInBackground(): Promise<boolean> {
    try {
      const { changed } = await this.refreshModels({ force: false })
      if (!this.disposed && changed) {
        this.onCatalogChanged?.()
      }
      return changed
    } catch {
      return false
    }
  }

  hasSession(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  private async loadPersistedCooldown(): Promise<void> {
    if (this.cooldownLoaded) return
    this.cooldownLoaded = true
    try {
      const val = (await Effect.runPromise(this.ctx.storage.get(COOLDOWN_STORAGE_KEY))) as
        | { readonly until?: unknown; readonly reason?: unknown }
        | undefined
      if (
        val &&
        typeof val === "object" &&
        typeof val.until === "number" &&
        val.until > Date.now() &&
        val.until > this.circuitBrokenUntil
      ) {
        this.circuitBrokenUntil = val.until
        this.circuitReason = typeof val.reason === "string" ? val.reason : "upstream error"
      }
    } catch {}
  }

  private persistCooldown(until: number, reason: string): void {
    try {
      Effect.runFork(
        this.ctx.storage
          .set(COOLDOWN_STORAGE_KEY, { until, reason })
          .pipe(Effect.catch(() => Effect.void)),
      )
    } catch {}
  }

  private tripCircuitBreaker(reason: string): void {
    this.circuitBrokenUntil = Date.now() + 60_000
    this.circuitReason = reason.trim().slice(0, 180)
    this.persistCooldown(this.circuitBrokenUntil, this.circuitReason)
  }

  private getOrCreateSession(sessionID: string): BridgeSession {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = {
        sessionID,
        cwd: this.defaultCwd,
        mode: "auto",
        relayAllTools: false,
        lastError: null,
      }
      this.sessions.set(sessionID, s)
    }
    return s
  }

  updateContextSnapshot(
    sessionID: string,
    input: {
      readonly systemText: string
      readonly agent: string
      readonly tools: Record<string, { readonly description: string; readonly input: any }>
    },
  ): void {
    const s = this.getOrCreateSession(sessionID)
    const toolSignature = Object.keys(input.tools).join("\0")
    const prev = s.contextSnapshot
    if (
      prev &&
      prev.systemText === input.systemText &&
      prev.agent === input.agent &&
      prev.toolSignature === toolSignature
    ) {
      return
    }
    const { mcpDescriptors, mcpSafeToOriginal } = buildDescriptors(input.tools, s.relayAllTools)
    s.contextSnapshot = {
      systemText: input.systemText,
      agent: input.agent,
      toolSignature,
      tools: input.tools,
      mcpDescriptors,
      mcpSafeToOriginal,
    }
  }

  getState(sessionID: string): SessionPublicState {
    const s = this.sessions.get(sessionID)
    return {
      sessionID,
      mode: s?.mode ?? "auto",
      relayAllTools: s?.relayAllTools ?? false,
      acpSessionId: s?.acpSessionId ?? null,
      connected: Boolean(s?.proc && !s.proc.isClosed && s.acpSessionId),
      busy: Boolean(s?.activeTurn),
      modelCount: this.catalog.length,
      relayedToolCount: s?.contextSnapshot?.mcpDescriptors.length ?? 0,
      lastError: s?.lastError ?? null,
      cooldownUntil: this.circuitBrokenUntil > Date.now() ? this.circuitBrokenUntil : null,
    }
  }

  async setMode(sessionID: string, mode: AcpMode): Promise<SessionPublicState> {
    const s = this.getOrCreateSession(sessionID)
    s.mode = mode
    if (s.proc && !s.proc.isClosed && s.acpSessionId) {
      try {
        await s.proc.setMode(s.acpSessionId, mode)
        s.lastModeApplied = mode
      } catch (err) {
        s.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    this.notifyChanged(sessionID)
    return this.getState(sessionID)
  }

  async setRelayAll(sessionID: string, relayAllTools: boolean): Promise<SessionPublicState> {
    const s = this.getOrCreateSession(sessionID)
    s.relayAllTools = relayAllTools
    if (s.contextSnapshot) {
      const { mcpDescriptors, mcpSafeToOriginal } = buildDescriptors(
        s.contextSnapshot.tools,
        relayAllTools,
      )
      s.contextSnapshot = {
        ...s.contextSnapshot,
        mcpDescriptors,
        mcpSafeToOriginal,
      }
    }
    // Reset ACP session so agy re-fetches MCP tools/list cleanly on next turn
    await this.resetSession(sessionID)
    return this.getState(sessionID)
  }

  async resetSession(sessionID: string): Promise<SessionPublicState> {
    const s = this.sessions.get(sessionID)
    if (s) {
      await this.handleInterrupt(sessionID, "Session reset by user")
      if (s.proc) {
        const proc = s.proc
        const acpSid = s.acpSessionId
        this.intentionallyDisposed.add(proc)
        s.proc = undefined
        s.acpSessionId = undefined
        if (acpSid) await proc.closeSession(acpSid)
        await proc.dispose()
        this.activeProcs.delete(proc)
      s.lastContextUsed = undefined
      }
      s.acpSessionId = undefined
      s.lastModelId = undefined
      s.lastModeApplied = undefined
      s.lastError = null
      s.needsReplayHistory = true
      await this.runStorageRemove(sessionID)
    }
    this.notifyChanged(sessionID)
    return this.getState(sessionID)
  }

  async handleInterrupt(sessionID: string, reason = "Cancelled"): Promise<void> {
    const s = this.sessions.get(sessionID)
    if (!s?.activeTurn) return
    const turn = s.activeTurn
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer)
      turn.flushTimer = undefined
    }
    this.detachController(turn)
    for (const call of turn.pendingMcpCalls.values()) {
      if (!call.resolved) {
        call.resolved = true
        call.resolve({
          content: [{ type: "text", text: reason }],
          isError: true,
        })
      }
    }
    turn.pendingMcpCalls.clear()
    turn.dispatchedCallIds.clear()

    if (s.proc && !s.proc.isClosed && s.acpSessionId) {
      await s.proc.cancel(s.acpSessionId)
    }
    this.finishControllerWithError(turn, new Error(reason))
    s.activeTurn = undefined
    this.notifyChanged(sessionID)
  }

  private finishTurnCleanStop(
    s: BridgeSession,
    turn: ActiveTurn,
    text: string,
    rawFinish: string,
  ): void {
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer)
      turn.flushTimer = undefined
    }
    for (const call of turn.pendingMcpCalls.values()) {
      if (!call.resolved) {
        call.resolved = true
        call.resolve({
          content: [{ type: "text", text }],
          isError: true,
        })
      }
    }
    turn.pendingMcpCalls.clear()
    turn.dispatchedCallIds.clear()

    this.closeOpenBlocks(turn)
    const textId = `t_${++turn.partSeq}`
    this.emitPart(turn, {
      type: "text-start",
      id: textId,
      providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
    })
    this.emitPart(turn, {
      type: "text-delta",
      id: textId,
      delta: text,
    })
    this.emitPart(turn, {
      type: "text-end",
      id: textId,
      providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
    })
    this.emitPart(turn, {
      type: "finish",
      finishReason: { unified: "stop", raw: rawFinish },
      usage: zeroUsage(),
      providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
    })
    const ctrl = this.detachController(turn)
    try {
      ctrl?.close()
    } catch {}
    if (s.activeTurn === turn) {
      s.activeTurn = undefined
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    const snapshot = [...this.sessions.values()]
    for (const s of snapshot) {
      if (s.activeTurn) {
        this.finishTurnCleanStop(
          s,
          s.activeTurn,
          "Antigravity ACP plugin was disabled or reloaded. Re-enable or send a new message to continue.",
          "plugin_unloaded",
        )
      }
      if (s.proc) {
        const proc = s.proc
        const acpSid = s.acpSessionId
        this.intentionallyDisposed.add(proc)
        s.proc = undefined
        s.acpSessionId = undefined
        if (!proc.isClosed && acpSid) {
          proc.notifyCancel(acpSid)
        }
        await proc.dispose()
        this.activeProcs.delete(proc)
      }
    }
    for (const proc of [...this.activeProcs]) {
      this.intentionallyDisposed.add(proc)
      await proc.dispose()
    }
    this.activeProcs.clear()
    this.sessions.clear()
    await this.mcpRelay.stop()
  }

  private notifyChanged(sessionID: string): void {
    try {
      this.onStateChanged?.(sessionID)
    } catch {}
  }

  private async runStorageGet(sessionID: string): Promise<string | undefined> {
    try {
      const val = await Effect.runPromise(this.ctx.storage.get(`${STORAGE_KEY_PREFIX}${sessionID}`))
      return typeof val === "string" && val.length > 0 ? val : undefined
    } catch {
      return undefined
    }
  }

  private async runStorageSet(sessionID: string, acpSessionId: string): Promise<void> {
    try {
      await Effect.runPromise(
        this.ctx.storage.set(`${STORAGE_KEY_PREFIX}${sessionID}`, acpSessionId),
      )
    } catch {}
  }

  private async runStorageRemove(sessionID: string): Promise<void> {
    try {
      await Effect.runPromise(this.ctx.storage.remove(`${STORAGE_KEY_PREFIX}${sessionID}`))
    } catch {}
  }

  private buildAppendSystemPrompt(s: BridgeSession): string {
    const sections: string[] = []
    sections.push(
      [
        "<workspace_tools_bridge>",
        "Additional workspace tools (including `mcp_oc_bash`, JavaScript tool runner `mcp_oc_execute`, and skill loader `mcp_oc_skill`) are attached to this session as MCP tools prefixed with `mcp_oc_`.",
        "- Always use `mcp_oc_bash` (instead of built-in `run_command`) to run shell commands, builds, and tests so they execute synchronously until completion without background sleep.",
        "- When a task requires another tool from the catalog below, call `mcp_oc_execute` with JavaScript using `await tools.<server>.<tool>(...)`, or call the matching `mcp_oc_*` tool directly.",
        "- Built-in file tools remain available for normal workspace file operations.",
        "</workspace_tools_bridge>",
      ].join("\n"),
    )

    const trimmedContext = (s.contextSnapshot?.systemText || "").trim()
    if (trimmedContext) {
      sections.push(`<workspace_context>\n${trimmedContext}\n</workspace_context>`)
    }

    const finalPrompt = sections.join("\n\n")
    if (UNSAFE_INTERNAL_SIGNATURE.test(finalPrompt)) {
      throw new Error("Refusing to send unsafe internal signature to Antigravity ACP")
    }
    return finalPrompt
  }

  private async ensureAcpSession(
    s: BridgeSession,
  ): Promise<{ proc: AcpProcess; acpSessionId: string; freshSession: boolean }> {
    if (this.disposed) throw new PluginDisposedError()
    if (s.startLock) await s.startLock
    if (this.disposed) throw new PluginDisposedError()
    if (s.proc && !s.proc.isClosed && s.acpSessionId) {
      return { proc: s.proc, acpSessionId: s.acpSessionId, freshSession: false }
    }

    let freshSession = false
    const startPromise = (async () => {
      try {
        const info = await Effect.runPromise(
          this.ctx.session.get({ sessionID: s.sessionID as any }),
        )
        const dir = (info as any)?.location?.directory ?? (info as any)?.directory
        if (typeof dir === "string" && dir.length > 0) {
          s.cwd = dir
        }
      } catch {}

      if (this.disposed) throw new PluginDisposedError()
      await this.mcpRelay.start()
      if (this.disposed) throw new PluginDisposedError()

      const relayUrl = this.mcpRelay.urlForSession(s.sessionID)
      let disposedByBridge = false
      const proc = new AcpProcess({
        cwd: s.cwd,
        dangerouslySkipPermissions: false,
        onUpdate: (_sid, update) => this.handleAcpUpdate(s, update),
        onPermissionRequest: (params) => this.handlePermissionRequest(s, params),
        onExit: (code, signal, tail) => {
          this.activeProcs.delete(proc)
          if (
            disposedByBridge ||
            this.disposed ||
            this.intentionallyDisposed.has(proc) ||
            (s.proc && s.proc !== proc)
          ) {
            return
          }
          s.lastError = `agy acp exited (code=${code}, signal=${signal})${tail ? `: ${tail.split("\n").at(-1)}` : ""}`
          if (s.activeTurn) {
            this.finishControllerWithError(
              s.activeTurn,
              new Error(s.lastError),
            )
            for (const c of s.activeTurn.pendingMcpCalls.values()) {
              if (!c.resolved) {
                c.resolved = true
                c.resolve({ content: [{ type: "text", text: "ACP process exited" }], isError: true })
              }
            }
            s.activeTurn = undefined
          }
          if (s.proc === proc) s.proc = undefined
          this.notifyChanged(s.sessionID)
        },
      })
      this.activeProcs.add(proc)

      try {
        const appendSystemPrompt = this.buildAppendSystemPrompt(s)
        await proc.initialize()
        if (this.disposed) throw new PluginDisposedError()
        const mcpServers = [
          {
            type: "http" as const,
            name: "oc",
            url: relayUrl,
            headers: this.mcpRelay.authHeaders(),
          },
        ]

        const storedId = s.acpSessionId ?? (await this.runStorageGet(s.sessionID))
        if (this.disposed) throw new PluginDisposedError()
        let res: any
        if (storedId) {
          try {
            res = await proc.resumeSession({
              sessionId: storedId,
              cwd: s.cwd,
              mcpServers,
              appendSystemPrompt,
            })
          } catch {
            res = undefined
          }
        }

        if (this.disposed) throw new PluginDisposedError()
        if (!res?.sessionId) {
          freshSession = true
          res = await proc.newSession({
            cwd: s.cwd,
            mcpServers,
            appendSystemPrompt,
          })
        }

        if (this.disposed) throw new PluginDisposedError()
        s.proc = proc
        s.acpSessionId = String(res.sessionId)
        s.lastError = null
        await this.runStorageSet(s.sessionID, s.acpSessionId)

        if (res?.models?.availableModels?.length || res?.configOptions?.length) {
          const live = normalizeCatalog(buildModelCatalog(res))
          if (live.length > 0 && catalogSignature(live) !== catalogSignature(this.catalog)) {
            const updatedAt = Date.now()
            this.catalog = live
            sharedCatalog = live
            sharedCatalogUpdatedAt = updatedAt
            void this.persistCatalog(live, updatedAt)
            if (!this.disposed) {
              this.onCatalogChanged?.()
            }
          }
        }

        if (s.mode !== "default") {
          await proc.setMode(s.acpSessionId, s.mode).catch(() => {})
          s.lastModeApplied = s.mode
        }
        if (this.disposed) throw new PluginDisposedError()
      } catch (err) {
        disposedByBridge = true
        this.activeProcs.delete(proc)
        if (s.proc === proc) {
          s.proc = undefined
          s.acpSessionId = undefined
        }
        await proc.dispose()
        throw err
      }
    })()

    s.startLock = startPromise.finally(() => {
      s.startLock = undefined
    })
    await s.startLock
    if (this.disposed || !s.proc || !s.acpSessionId) {
      throw new PluginDisposedError()
    }
    this.notifyChanged(s.sessionID)
    return { proc: s.proc, acpSessionId: s.acpSessionId, freshSession }
  }

  private async handlePermissionRequest(
    s: BridgeSession,
    params: AcpPermissionRequestParams,
  ): Promise<AcpPermissionOutcome> {
    const opts = params.options ?? []
    const allowOpt =
      opts.find(
        (o) =>
          o.kind === "allow_once" ||
          o.kind === "allow_always" ||
          o.optionId.includes("allow"),
      ) ?? opts[0]
    const denyOpt = opts.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always" || o.optionId.includes("deny"),
    )

    const toolName = String(params.toolCall?.name ?? params.toolCall?.kind ?? "unknown")
    // Always allow the internal MCP relay inside ACP: OpenCode itself enforces real permissions when running the tool!
    if (toolName.startsWith("mcp_oc_")) {
      return allowOpt
        ? { outcome: "selected", optionId: allowOpt.optionId }
        : { outcome: "cancelled" }
    }

    if (s.mode === "auto") {
      return allowOpt
        ? { outcome: "selected", optionId: allowOpt.optionId }
        : { outcome: "cancelled" }
    }

    const title = String(params.toolCall?.title ?? toolName)
    const resources: string[] = []
    if (Array.isArray(params.toolCall?.locations)) {
      for (const loc of params.toolCall.locations) {
        if (loc?.path) resources.push(loc.path)
      }
    }
    if (resources.length === 0) resources.push(title)

    try {
      await Effect.runPromise(
        this.ctx.permission.assert({
          sessionID: s.sessionID as any,
          agent: (s.contextSnapshot?.agent ?? "build") as any,
          action: `antigravity.${params.toolCall?.kind ?? toolName}`,
          resources,
          metadata: {
            tool: toolName,
            title,
            rawInput: params.toolCall?.rawInput,
          },
        }),
      )
      return allowOpt
        ? { outcome: "selected", optionId: allowOpt.optionId }
        : { outcome: "cancelled" }
    } catch {
      return denyOpt
        ? { outcome: "selected", optionId: denyOpt.optionId }
        : { outcome: "cancelled" }
    }
  }

  private async handleIncomingMcpCall(
    sessionID: string,
    mcpToolName: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<McpCallToolResult> {
    const s = this.sessions.get(sessionID)
    const turn = s?.activeTurn
    if (!s || !turn) {
      return {
        content: [{ type: "text", text: "No active Antigravity turn to execute OpenCode tool." }],
        isError: true,
      }
    }

    const openCodeToolName = s.contextSnapshot?.mcpSafeToOriginal.get(mcpToolName) ?? mcpToolName
    const toolCallId = `oc_relay_${++turn.partSeq}_${Math.random().toString(36).slice(2, 8)}`

    return new Promise<McpCallToolResult>((resolve) => {
      const entry: PendingMcpCall = {
        toolCallId,
        mcpName: mcpToolName,
        openCodeToolName,
        args,
        emittedToOpenCode: false,
        resolved: false,
        resolve,
      }
      turn.pendingMcpCalls.set(toolCallId, entry)

      const onAbort = () => {
        if (!entry.resolved) {
          entry.resolved = true
          turn.pendingMcpCalls.delete(toolCallId)
          resolve({
            content: [{ type: "text", text: "MCP tool call aborted by ACP host." }],
            isError: true,
          })
        }
      }
      signal.addEventListener("abort", onAbort, { once: true })

      this.scheduleFlushToolCalls(s, turn)
    })
  }

  private scheduleFlushToolCalls(s: BridgeSession, turn: ActiveTurn): void {
    if (turn.flushTimer) clearTimeout(turn.flushTimer)
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = undefined
      this.tryFlushToolCalls(s, turn)
    }, 60)
  }

  private tryFlushToolCalls(s: BridgeSession, turn: ActiveTurn): void {
    if (!turn.controller) return
    // Wait for any concurrent Antigravity native hosted tool calls to settle first
    if (turn.activeNativeTools.size > 0) return

    const unsent = [...turn.pendingMcpCalls.values()].filter((c) => !c.emittedToOpenCode)
    if (unsent.length === 0) return

    this.closeOpenBlocks(turn)
    for (const call of unsent) {
      call.emittedToOpenCode = true
      turn.dispatchedCallIds.add(call.toolCallId)
      const jsonInput = JSON.stringify(call.args ?? {})
      this.emitPart(turn, {
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: call.openCodeToolName,
        providerExecuted: false,
      })
      this.emitPart(turn, {
        type: "tool-input-delta",
        id: call.toolCallId,
        delta: jsonInput,
      })
      this.emitPart(turn, {
        type: "tool-input-end",
        id: call.toolCallId,
      })
      this.emitPart(turn, {
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.openCodeToolName,
        input: jsonInput,
        providerExecuted: false,
        providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
      })
    }

    const finishReason: LanguageModelV3FinishReason = {
      unified: "tool-calls",
      raw: "tool_calls",
    }
    this.emitPart(turn, {
      type: "finish",
      finishReason,
      usage: zeroUsage(),
      providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
    })
    const ctrl = this.detachController(turn)
    try {
      ctrl?.close()
    } catch {}
  }

  private detachController(turn: ActiveTurn): ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined {
    const ctrl = turn.controller
    turn.controller = undefined
    const cleanup = turn.controllerCleanup
    turn.controllerCleanup = undefined
    cleanup?.()
    return ctrl
  }

  private createBoundStream(
    s: BridgeSession,
    turn: ActiveTurn,
    abortSignal: AbortSignal | undefined,
    onStart: (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => void,
  ): ReadableStream<LanguageModelV3StreamPart> {
    let stepController: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined
    return new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        stepController = controller
        turn.controller = controller
        if (abortSignal) {
          const onAbort = () => {
            if (turn.controller === stepController) {
              void this.handleInterrupt(s.sessionID, "Aborted")
            }
          }
          if (abortSignal.aborted) {
            onAbort()
          } else {
            abortSignal.addEventListener("abort", onAbort, { once: true })
            turn.controllerCleanup = () => abortSignal.removeEventListener("abort", onAbort)
          }
        }
        controller.enqueue({ type: "stream-start", warnings: [] })
        onStart(controller)
      },
      cancel: () => {
        if (turn.controller === stepController) {
          void this.handleInterrupt(s.sessionID, "Stream cancelled")
        }
      },
    })
  }

  private emitPart(turn: ActiveTurn, part: LanguageModelV3StreamPart): void {
    if (turn.controller) {
      try {
        turn.controller.enqueue(part)
        return
      } catch {}
    }
    turn.bufferedParts.push(part)
  }

  private closeOpenBlocks(turn: ActiveTurn): void {
    if (turn.openReasoningId) {
      const id = turn.openReasoningId
      turn.openReasoningId = undefined
      this.emitPart(turn, {
        type: "reasoning-end",
        id,
        providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
      })
    }
    if (turn.openTextId) {
      const id = turn.openTextId
      turn.openTextId = undefined
      this.emitPart(turn, {
        type: "text-end",
        id,
        providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
      })
    }
  }

  private finishControllerWithError(turn: ActiveTurn, error: Error): void {
    const ctrl = this.detachController(turn)
    if (!ctrl) {
      turn.bufferedParts.push({ type: "error", error })
      return
    }
    try {
      ctrl.enqueue({ type: "error", error })
      ctrl.close()
    } catch {}
  }

  private handleAcpUpdate(s: BridgeSession, update: AcpSessionUpdate): void {
    const kind = update.sessionUpdate
    if (kind === "session_info_update" && typeof update.title === "string" && update.title.trim()) {
      const title = update.title.trim()
      if (s.lastTitleSent !== title) {
        s.lastTitleSent = title
        Effect.runFork(
          this.ctx.session.update({ sessionID: s.sessionID as any, title }).pipe(
            Effect.catch(() => Effect.void),
          ),
        )
      }
      return
    }

    if (kind === "usage_update") {
      if (typeof update.used === "number" && Number.isFinite(update.used) && update.used >= 0) {
        s.lastContextUsed = update.used
      }
      return
    }

    const turn = s.activeTurn
    if (!turn || turn.abortedOnApiError) return

    if (kind === "agent_thought_chunk") {
      const text = (update.content as any)?.text
      if (typeof text !== "string" || text.length === 0) return
      if (turn.openTextId) {
        const tid = turn.openTextId
        turn.openTextId = undefined
        this.emitPart(turn, {
          type: "text-end",
          id: tid,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
      }
      if (!turn.openReasoningId) {
        turn.openReasoningId = `r_${++turn.partSeq}`
        this.emitPart(turn, {
          type: "reasoning-start",
          id: turn.openReasoningId,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
      }
      this.emitPart(turn, {
        type: "reasoning-delta",
        id: turn.openReasoningId,
        delta: text,
      })
      return
    }

    if (kind === "agent_message_chunk") {
      const text = (update.content as any)?.text
      if (typeof text !== "string" || text.length === 0) return

      if (API_ERROR_ABORT_PATTERN.test(text)) {
        turn.abortedOnApiError = true
        this.tripCircuitBreaker(text)
        s.lastError = this.circuitReason

        const proc = s.proc
        const sid = s.acpSessionId
        s.proc = undefined
        s.acpSessionId = undefined
        if (proc) {
          this.intentionallyDisposed.add(proc)
          this.activeProcs.delete(proc)
          if (!proc.isClosed) {
            if (sid) proc.notifyCancel(sid)
            proc.killImmediate()
          }
        }

        this.finishTurnCleanStop(
          s,
          turn,
          `Antigravity ACP halted immediately after 1st upstream error to prevent retry loops:\n${text.trim()}`,
          "api_error_halted",
        )
        this.notifyChanged(s.sessionID)
        return
      }

      if (turn.openReasoningId) {
        const rid = turn.openReasoningId
        turn.openReasoningId = undefined
        this.emitPart(turn, {
          type: "reasoning-end",
          id: rid,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
      }
      if (!turn.openTextId) {
        turn.openTextId = `t_${++turn.partSeq}`
        this.emitPart(turn, {
          type: "text-start",
          id: turn.openTextId,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
      }
      this.emitPart(turn, {
        type: "text-delta",
        id: turn.openTextId,
        delta: text,
      })
      return
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const callId = String(update.toolCallId ?? "")
      if (!callId) return
      const name = String(update.name ?? update.kind ?? "acp_tool")

      // Relayed OpenCode MCP tools are already emitted natively from handleIncomingMcpCall!
      if (name.startsWith("mcp_oc_") || turn.relayedUpdateIds.has(callId)) {
        turn.relayedUpdateIds.add(callId)
        return
      }

      const status = String(update.status ?? "")
      if (kind === "tool_call" && !turn.activeNativeTools.has(callId)) {
        this.closeOpenBlocks(turn)
        const rawInput = update.rawInput ?? update.args ?? {}
        const jsonInput = JSON.stringify(rawInput)
        const displayName = `acp_${name}`
        turn.activeNativeTools.set(callId, displayName)
        this.emitPart(turn, {
          type: "tool-input-start",
          id: callId,
          toolName: displayName,
          providerExecuted: true,
        })
        this.emitPart(turn, {
          type: "tool-input-delta",
          id: callId,
          delta: jsonInput,
        })
        this.emitPart(turn, {
          type: "tool-input-end",
          id: callId,
        })
        this.emitPart(turn, {
          type: "tool-call",
          toolCallId: callId,
          toolName: displayName,
          input: jsonInput,
          providerExecuted: true,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
      }

      if (
        (status === "completed" || status === "failed" || status === "error" || status === "cancelled") &&
        turn.activeNativeTools.has(callId)
      ) {
        const displayName = turn.activeNativeTools.get(callId) ?? `acp_${name}`
        turn.activeNativeTools.delete(callId)
        const isError = status !== "completed"
        const resultPayload = extractToolContentText(update)
        this.emitPart(turn, {
          type: "tool-result",
          toolCallId: callId,
          toolName: displayName,
          result: (resultPayload ?? { status }) as any,
          isError,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })

        // If any relayed OpenCode tool calls were waiting for this native tool to settle, flush them now!
        if (turn.activeNativeTools.size === 0 && turn.pendingMcpCalls.size > 0) {
          this.tryFlushToolCalls(s, turn)
        }
      }
    }
  }

  private finalizeTurnStop(s: BridgeSession, turn: ActiveTurn): void {
    // Emit any remaining buffered native chunks, close open text/reasoning, emit finish:stop
    this.closeOpenBlocks(turn)
    if (turn.activeNativeTools.size > 0) {
    for (const [id, toolName] of turn.activeNativeTools) {
      this.emitPart(turn, {
        type: "tool-result",
        toolCallId: id,
        toolName,
        result: { status: "completed" },
        isError: false,
        providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
      })
    }
    turn.activeNativeTools.clear()
  }

    const stopReason = turn.promptResult?.stopReason
    const unified: LanguageModelV3FinishReason["unified"] =
      stopReason === "max_tokens" ? "length" : "stop"

    this.emitPart(turn, {
      type: "finish",
      finishReason: { unified, raw: stopReason ?? "end_turn" },
      usage: zeroUsage(turn.promptResult?.usage, s.lastContextUsed),
      providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
    })

    const ctrl = this.detachController(turn)
    try {
      ctrl?.close()
    } catch {}
    if (s.activeTurn === turn) {
      s.activeTurn = undefined
    }
    this.notifyChanged(s.sessionID)
  }

  private createImmediateTextStream(
    text: string,
    rawFinish: string,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const id = "t_1"
    return new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        controller.enqueue({
          type: "text-start",
          id,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
        controller.enqueue({ type: "text-delta", id, delta: text })
        controller.enqueue({
          type: "text-end",
          id,
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: rawFinish },
          usage: zeroUsage(),
          providerMetadata: { [ACP_PROVIDER_ID]: { acp: true } },
        })
        controller.close()
      },
    })
  }

  createLanguageModel(modelID: string): LanguageModelV3 {
    const bridge = this
    return {
      specificationVersion: "v3",
      provider: ACP_PROVIDER_ID,
      modelId: modelID,
      supportedUrls: {},
      async doGenerate(options: LanguageModelV3CallOptions) {
        const { stream } = await this.doStream(options)
        const reader = stream.getReader()
        const texts: string[] = []
        const reasonings: string[] = []
        let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
        let usage: LanguageModelV3Usage = zeroUsage()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.type === "text-delta") texts.push(value.delta)
          else if (value.type === "reasoning-delta") reasonings.push(value.delta)
          else if (value.type === "finish") {
            finishReason = value.finishReason
            usage = value.usage
          } else if (value.type === "error") {
            throw value.error
          }
        }
        const content: any[] = []
        if (reasonings.length > 0) content.push({ type: "reasoning", text: reasonings.join("") })
        if (texts.length > 0) content.push({ type: "text", text: texts.join("") })
        return {
          content,
          finishReason,
          usage,
          warnings: [],
        }
      },
      async doStream(options: LanguageModelV3CallOptions) {
        if (bridge.disposed) {
          return {
            stream: bridge.createImmediateTextStream(
              "Antigravity ACP plugin was disabled or reloaded. Send a new message to continue.",
              "plugin_disposed",
            ),
          }
        }
        const hdrs = options.headers ?? {}
        const sessionID = String(hdrs["x-opencode-session-id"] ?? "__default__")
        const variant = String(hdrs["x-opencode-variant"] ?? "") || undefined
        const reqKind = String(hdrs["x-opencode-request-kind"] ?? "primary")
        const s = bridge.getOrCreateSession(sessionID)

        // Check if this is an OpenCode tool-result continuation step for an active ACP turn
        const existingTurn = s.activeTurn
        if (existingTurn && existingTurn.dispatchedCallIds.size > 0) {
          const matchedResults = extractToolResultsFromPrompt(
            options.prompt,
            existingTurn.dispatchedCallIds,
          )
          if (matchedResults.size > 0) {
            const stream = bridge.createBoundStream(s, existingTurn, options.abortSignal, (controller) => {
              while (existingTurn.bufferedParts.length > 0) {
                controller.enqueue(existingTurn.bufferedParts.shift()!)
              }

              // Feed OpenCode's tool results back into the waiting HTTP MCP calls
              for (const callId of [...existingTurn.dispatchedCallIds]) {
                existingTurn.dispatchedCallIds.delete(callId)
                const pending = existingTurn.pendingMcpCalls.get(callId)
                if (!pending) continue
                existingTurn.pendingMcpCalls.delete(callId)
                if (!pending.resolved) {
                  pending.resolved = true
                  const res = matchedResults.get(callId) ?? {
                    text: "Tool returned no output",
                    isError: false,
                  }
                  pending.resolve({
                    content: [{ type: "text", text: res.text }],
                    isError: res.isError,
                  })
                }
              }

              if (existingTurn.promptSettled) {
                if (existingTurn.promptError) {
                  bridge.finishControllerWithError(existingTurn, existingTurn.promptError)
                  s.activeTurn = undefined
                } else {
                  bridge.finalizeTurnStop(s, existingTurn)
                }
              } else if (!existingTurn.flushTimer && existingTurn.pendingMcpCalls.size > 0) {
                bridge.scheduleFlushToolCalls(s, existingTurn)
              }
            })
            return { stream }
          }

          // Mismatched turn (user interrupted & sent new prompt): tear down stale activeTurn
          await bridge.handleInterrupt(sessionID, "Superseded by new prompt")
        } else if (existingTurn) {
          await bridge.handleInterrupt(sessionID, "Superseded by new prompt")
        }

        if (isSyntheticRestartAfterError(options.prompt)) {
          return {
            stream: bridge.createImmediateTextStream(
              "Skipped auto-resume after server restart because the previous Antigravity turn halted on an API error. Send a new message when ready.",
              "restart_skipped",
            ),
          }
        }

        await bridge.loadPersistedCooldown()

        if (Date.now() < bridge.circuitBrokenUntil) {
          const secs = Math.ceil((bridge.circuitBrokenUntil - Date.now()) / 1000)
          return {
            stream: bridge.createImmediateTextStream(
              `Antigravity ACP cooldown active (${secs}s remaining) after upstream API error (${bridge.circuitReason ?? "rate limit/error"}) to protect your account from retry loops.`,
              "circuit_open",
            ),
          }
        }

        let ensured: { proc: AcpProcess; acpSessionId: string; freshSession: boolean }
        try {
          ensured = await bridge.ensureAcpSession(s)
        } catch (err) {
          if (err instanceof PluginDisposedError || bridge.disposed) {
            return {
              stream: bridge.createImmediateTextStream(
                "Antigravity ACP plugin was disabled or reloaded. Send a new message to continue.",
                "plugin_disposed",
              ),
            }
          }
          if (err instanceof AgyNotFoundError || (err as NodeJS.ErrnoException)?.code === "ENOENT") {
            const msg = err instanceof Error ? err.message : String(err)
            s.lastError = msg
            bridge.notifyChanged(sessionID)
            return {
              stream: bridge.createImmediateTextStream(msg, "agy_unavailable"),
            }
          }
          throw err
        }
        const { proc, acpSessionId, freshSession } = ensured

        // Apply model + thinking level target
        const target = resolveAcpModelTarget(bridge.catalog, modelID, variant)
        if (s.lastModelId !== target.acpModelId) {
          try {
            await proc.setModel(acpSessionId, target.acpModelId)
          } catch {
            // Fallback to configOptions if combined ID isn't accepted on a model update
            await proc.setConfigOption(acpSessionId, "model", target.baseModelId).catch(() => {})
            if (target.thoughtLevel) {
              await proc
                .setConfigOption(acpSessionId, "thought_level", target.thoughtLevel)
                .catch(() => {})
            }
          }
          s.lastModelId = target.acpModelId
        }

        const promptBlocks = buildAcpPromptBlocks(options.prompt, {
          forceFullHistory: freshSession || Boolean(s.needsReplayHistory) || reqKind !== "primary",
        })
        if (reqKind === "primary") {
          s.needsReplayHistory = false
        }

        const turn: ActiveTurn = {
          bufferedParts: [],
          partSeq: 0,
          activeNativeTools: new Map(),
          relayedUpdateIds: new Set(),
          pendingMcpCalls: new Map(),
          dispatchedCallIds: new Set(),
          promptSettled: false,
        }
        s.activeTurn = turn
        bridge.notifyChanged(sessionID)

        const stream = bridge.createBoundStream(s, turn, options.abortSignal, () => {
          proc
            .prompt(acpSessionId, promptBlocks)
            .then((res) => {
              if (turn.abortedOnApiError || bridge.disposed) return
              turn.promptSettled = true
              turn.promptResult = res
              s.lastError = null
              if (turn.flushTimer) {
                clearTimeout(turn.flushTimer)
                turn.flushTimer = undefined
              }
              // Wait if any OpenCode tool call is still mid-roundtrip (shouldn't happen before HTTP reply, unless aborted)
              if (turn.dispatchedCallIds.size === 0 && turn.controller) {
                bridge.finalizeTurnStop(s, turn)
              }
            })
            .catch((err) => {
              if (turn.abortedOnApiError || bridge.disposed) return
              turn.promptSettled = true
              const error = err instanceof Error ? err : new Error(String(err))
              turn.promptError = error

              if (API_ERROR_ABORT_PATTERN.test(error.message)) {
                turn.abortedOnApiError = true
                bridge.tripCircuitBreaker(error.message)
                s.lastError = bridge.circuitReason
                bridge.intentionallyDisposed.add(proc)
                bridge.activeProcs.delete(proc)
                if (s.proc === proc) {
                  s.proc = undefined
                  s.acpSessionId = undefined
                }
                proc.killImmediate()
                bridge.finishTurnCleanStop(
                  s,
                  turn,
                  `Antigravity ACP halted immediately after upstream API error to prevent retry loops:\n${error.message}`,
                  "api_error_halted",
                )
                bridge.notifyChanged(sessionID)
                return
              }

              if (turn.flushTimer) {
                clearTimeout(turn.flushTimer)
                turn.flushTimer = undefined
              }
              for (const c of turn.pendingMcpCalls.values()) {
                if (!c.resolved) {
                  c.resolved = true
                  c.resolve({ content: [{ type: "text", text: error.message }], isError: true })
                }
              }
              turn.pendingMcpCalls.clear()
              turn.dispatchedCallIds.clear()

              s.lastError = error.message
              bridge.finishControllerWithError(turn, error)
              if (s.activeTurn === turn) s.activeTurn = undefined
              bridge.notifyChanged(sessionID)
            })
        })

        return { stream }
      },
    }
  }
}
