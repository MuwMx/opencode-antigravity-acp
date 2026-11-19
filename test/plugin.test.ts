import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import {
  AgyNotFoundError,
  FALLBACK_MODELS,
  buildModelCatalog,
  discoverAcpModels,
  resolveAgyBinary,
  type AcpDiscoveredModel,
} from "../src/acp-client.js"
import {
  API_ERROR_ABORT_PATTERN,
  UNSAFE_INTERNAL_SIGNATURE,
  buildAcpPromptBlocks,
  extractSafeAcpContext,
  isSyntheticRestartAfterError,
  sanitizeForAcpModel,
  sanitizeForNonAcpModel,
  stripUnsafeInternalLines,
} from "../src/history-sanitizer.js"
import { McpRelayServer } from "../src/mcp-relay.js"
import {
  SessionBridgeManager,
  resetSharedCatalogForTests,
} from "../src/session-bridge.js"

function makeMockCtx(initialStorage?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(initialStorage ?? {}))
  return {
    location: { directory: "/tmp/acp-test-dir" },
    storage: {
      get: (k: string) => Effect.succeed(store.get(k)),
      set: (k: string, v: unknown) => Effect.sync(() => void store.set(k, v)),
      remove: (k: string) => Effect.sync(() => void store.delete(k)),
    },
    session: {
      get: () => Effect.succeed({ location: { directory: "/tmp/acp-test-dir" } }),
      update: () => Effect.void,
    },
    permission: {
      assert: () => Effect.void,
    },
  } as any
}

async function readAllParts(stream: ReadableStream<any>) {
  const reader = stream.getReader()
  const parts: any[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

describe("resolveAgyBinary & missing binary handling", () => {
  test("respects AGY_BIN env override", () => {
    expect(resolveAgyBinary({ AGY_BIN: " /custom/path/agy " })).toBe("/custom/path/agy")
  })

  test("finds executable agy on PATH when present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-test-"))
    try {
      const fakeBin = path.join(tmpDir, process.platform === "win32" ? "agy.exe" : "agy")
      fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n")
      fs.chmodSync(fakeBin, 0o755)
      expect(resolveAgyBinary({ PATH: tmpDir })).toBe(fakeBin)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("discoverAcpModels throws AgyNotFoundError on missing binary", async () => {
    await expect(
      discoverAcpModels("/tmp", { binaryPath: "/nonexistent/path/agy-missing-bin" }),
    ).rejects.toBeInstanceOf(AgyNotFoundError)
  })
})

describe("McpRelayServer", () => {
  test("supports start -> stop -> start, concurrent stop, auth, and tool scrubbing", async () => {
    const relay = new McpRelayServer({
      getTools: () => [
        {
          name: "mcp_oc_execute",
          description: "Run JS code.\ntools.opencode.session_move({})\nSafe tool line.",
          inputSchema: { type: "object", properties: { code: { type: "string" } } },
        },
      ],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    })

    expect(() => relay.urlForSession("s1")).toThrow(/McpRelayServer has not started/)

    await relay.start()
    const url1 = relay.urlForSession("s1")
    expect(url1).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/s1$/)

    const unauth = await fetch(url1, { method: "POST", body: "{}" })
    expect(unauth.status).toBe(401)

    const listRes = await fetch(url1, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relay.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(listRes.status).toBe(200)
    const listJson = (await listRes.json()) as any
    const desc = listJson.result.tools[0].description as string
    expect(UNSAFE_INTERNAL_SIGNATURE.test(desc)).toBe(false)
    expect(desc).toContain("Safe tool line.")

    await relay.stop()
    expect(() => relay.urlForSession("s1")).toThrow(/McpRelayServer has not started/)

    await relay.start()
    const url2 = relay.urlForSession("s1")
    expect(url2).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/s1$/)
    await relay.stop()

    const startP = relay.start()
    const stopP = relay.stop()
    await Promise.allSettled([startP, stopP])
    expect(() => relay.urlForSession("s1")).toThrow(/McpRelayServer has not started/)
  })
})

describe("SessionBridgeManager lifecycle & cached discovery", () => {
  afterEach(() => {
    resetSharedCatalogForTests()
  })

  test("post-dispose cached LanguageModelV3 returns non-retryable plugin_disposed stop stream", async () => {
    const bridge = new SessionBridgeManager(makeMockCtx(), "/tmp/acp-test-dir")
    const cachedLm = bridge.createLanguageModel("gemini-4-neon")
    expect(bridge.getState("sess-1").cooldownUntil).toBeNull()

    await bridge.disposeAll()

    const res = await cachedLm.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      headers: { "x-opencode-session-id": "sess-1" },
    } as any)
    const parts = await readAllParts(res.stream)
    expect(parts.some((p) => p.type === "error")).toBe(false)
    const finish = parts.find((p) => p.type === "finish")
    expect(finish?.finishReason?.unified).toBe("stop")
    expect(finish?.finishReason?.raw).toBe("plugin_disposed")
  })

  test("mid-turn disposeAll() cleanly terminates stream with plugin_unloaded", async () => {
    const bridge = new SessionBridgeManager(makeMockCtx(), "/tmp/acp-test-dir")
    const sessionObj = (bridge as any).getOrCreateSession("sess-active")
    let resolvedMcp!: (res: any) => void
    const mcpPromise = new Promise((resolve) => {
      resolvedMcp = resolve
    })
    const turnObj: any = {
      bufferedParts: [],
      partSeq: 0,
      activeNativeTools: new Set(),
      relayedUpdateIds: new Set(),
      pendingMcpCalls: new Map([
        [
          "call-1",
          {
            toolCallId: "call-1",
            mcpName: "mcp_oc_execute",
            openCodeToolName: "mcp_oc_execute",
            args: {},
            emittedToOpenCode: false,
            resolved: false,
            resolve: resolvedMcp,
          },
        ],
      ]),
      dispatchedCallIds: new Set(),
      promptSettled: false,
    }
    const activeStream = (bridge as any).createBoundStream(sessionObj, turnObj, undefined, () => {})
    sessionObj.activeTurn = turnObj

    const streamReaderPromise = readAllParts(activeStream)
    await bridge.disposeAll()
    const midTurnParts = await streamReaderPromise
    const mcpResult = (await mcpPromise) as any
    expect(mcpResult.isError).toBe(true)
    expect(midTurnParts.some((p) => p.type === "error")).toBe(false)
    const midFinish = midTurnParts.find((p) => p.type === "finish")
    expect(midFinish?.finishReason?.unified).toBe("stop")
    expect(midFinish?.finishReason?.raw).toBe("plugin_unloaded")
  })

  test("surfaces AgyNotFoundError as non-retryable agy_unavailable stream", async () => {
    const bridge = new SessionBridgeManager(makeMockCtx(), "/tmp/acp-test-dir")
    ;(bridge as any).ensureAcpSession = async () => {
      throw new AgyNotFoundError("/missing/agy")
    }
    const lm = bridge.createLanguageModel("gemini-4-neon")
    const res = await lm.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "sess-missing" },
    } as any)
    const parts = await readAllParts(res.stream)
    expect(parts.some((p) => p.type === "error")).toBe(false)
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("")
    expect(text).toContain("Antigravity CLI")
    const finish = parts.find((p) => p.type === "finish")
    expect(finish?.finishReason?.raw).toBe("agy_unavailable")
    await bridge.disposeAll()
  })

  test("exposes cooldownUntil when circuit breaker is tripped", async () => {
    const bridge = new SessionBridgeManager(makeMockCtx(), "/tmp/acp-test-dir")
    ;(bridge as any).tripCircuitBreaker("RESOURCE_EXHAUSTED (code 429)")
    const st = bridge.getState("s3")
    expect(typeof st.cooldownUntil).toBe("number")
    expect(st.cooldownUntil!).toBeGreaterThan(Date.now())
    await bridge.disposeAll()
  })

  test("deduplicates live discovery and loads fresh catalog from storage cache", async () => {
    const liveModels: AcpDiscoveredModel[] = [
      {
        id: "gemini-4-carbon",
        name: "Gemini 4 Carbon",
        family: "gemini-4-carbon",
        defaultAcpModelId: "gemini-4-carbon-high",
        variants: [{ id: "high", acpModelId: "gemini-4-carbon-high", thoughtLevel: "high" }],
      },
    ]

    let discoverCalls = 0
    let reloadNotifications = 0
    const ctx = makeMockCtx()
    const discoverModels = async () => {
      discoverCalls++
      await new Promise((r) => setTimeout(r, 15))
      return liveModels
    }

    const b1 = new SessionBridgeManager(ctx, "/tmp/w1", undefined, {
      onCatalogChanged: () => reloadNotifications++,
      discoverModels,
    })
    const b2 = new SessionBridgeManager(ctx, "/tmp/w2", undefined, {
      onCatalogChanged: () => reloadNotifications++,
      discoverModels,
    })

    const c1 = await b1.loadCachedModels()
    const c2 = await b2.loadCachedModels()
    expect(c1.stale).toBe(true)
    expect(c2.stale).toBe(true)

    const [changed1, changed2] = await Promise.all([
      b1.refreshModelsInBackground(),
      b2.refreshModelsInBackground(),
    ])
    expect(discoverCalls).toBe(1)
    expect(changed1).toBe(true)
    expect(changed2).toBe(true)
    expect(reloadNotifications).toBe(2)
    expect(b1.getModels().map((m) => m.id)).toEqual(["gemini-4-carbon"])

    // Simulate fresh server restart where memory cache is cleared but storage persists
    resetSharedCatalogForTests()
    let warmDiscoverCalls = 0
    const b3 = new SessionBridgeManager(ctx, "/tmp/w1", undefined, {
      discoverModels: async () => {
        warmDiscoverCalls++
        return liveModels
      },
    })
    const c3 = await b3.loadCachedModels()
    expect(c3.stale).toBe(false)
    expect(c3.changed).toBe(true)
    expect(b3.getModels().map((m) => m.id)).toEqual(["gemini-4-carbon"])
    expect(warmDiscoverCalls).toBe(0)

    await Promise.all([b1.disposeAll(), b2.disposeAll(), b3.disposeAll()])
  })
})

describe("Model catalog & family visibility", () => {
  test("FALLBACK_MODELS has 9 distinct families and all 23 (model, variant) targets", () => {
    expect(FALLBACK_MODELS).toHaveLength(9)
    const families = new Set<string>()
    let totalTargets = 0
    for (const m of FALLBACK_MODELS) {
      expect(m.name).not.toContain("(ACP)")
      expect(m.family).toBe(m.id)
      expect(families.has(m.family!)).toBe(false)
      families.add(m.family!)
      totalTargets += m.variants.length > 0 ? m.variants.length : 1
    }
    expect(totalTargets).toBe(23)
    expect(FALLBACK_MODELS.find((m) => m.id === "gemini-pro-orchestrator-neon")?.name).toBe(
      "Orchestrator (Neon)",
    )
    expect(FALLBACK_MODELS.find((m) => m.id === "gemini-pro-orchestrator-g1-pro")?.name).toBe(
      "Orchestrator (Argon)",
    )
  })

  test("buildModelCatalog strips (ACP), discovers extra suffixes and standalone models", () => {
    const cat1 = buildModelCatalog({
      models: {
        availableModels: [{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium) (ACP)" }],
      },
      configOptions: [
        { id: "model", options: [{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium) (ACP)" }] },
      ],
    })
    expect(cat1[0].name).toBe("GPT-OSS 120B (Medium)")
    expect(cat1[0].family).toBe("gpt-oss-120b-medium")

    const cat2 = buildModelCatalog({
      models: {
        availableModels: [
          { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
          { modelId: "gemini-4-neon-minimal", name: "Gemini 4 Neon (Minimal)" },
          { modelId: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        ],
      },
      configOptions: [
        { id: "model", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
        { id: "thought_level", options: [{ value: "low" }, { value: "high" }] },
      ],
    })
    expect(cat2).toHaveLength(2)
    expect(cat2[0].variants.map((v) => v.id)).toEqual(["low", "minimal"])
    expect(cat2[0].family).toBe("gemini-4-neon")
    expect(cat2[1].id).toBe("gemini-4-carbon")
    expect(cat2[1].family).toBe("gemini-4-carbon")
  })
})

describe("History sanitizer & cross-model context handoff", () => {
  test("extractSafeAcpContext strips opencode internal signatures and keeps safe context", () => {
    const safeCtx = extractSafeAcpContext([
      {
        metadata: {
          experimental: {
            instructions: [
              { key: "core/instructions", text: "Repo AGENTS.md rule" },
              { key: "internal/opencode-system", text: "SHOULD BE DROPPED tools.opencode.session_move" },
              {
                key: "core/codemode",
                text: [
                  "- opencode: Internal controls",
                  "  opencode.session_move({ id })",
                  "  await tools.opencode.session_move()",
                  "- external_ns: Safe workspace tool",
                  "  external_ns.open({ url })",
                ].join("\n"),
              },
            ],
          },
        },
      },
    ])
    expect(safeCtx).toContain("Repo AGENTS.md rule")
    expect(safeCtx).toContain("external_ns")
    expect(UNSAFE_INTERNAL_SIGNATURE.test(safeCtx)).toBe(false)
    expect(safeCtx).not.toContain("SHOULD BE DROPPED")

    expect(stripUnsafeInternalLines("keep\ntools.opencode.session_move()\nsession_move\nok")).toBe(
      "keep\nok",
    )
    expect(API_ERROR_ABORT_PATTERN.test("⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429)")).toBe(
      true,
    )
    expect(API_ERROR_ABORT_PATTERN.test("Normal response chunk")).toBe(false)
  })

  test("preserves conversation context when switching between normal OpenCode and Antigravity models", () => {
    const priorOtherModelBlocks = buildAcpPromptBlocks(
      [
        { role: "user", content: [{ type: "text", text: "Secret codeword is ALPHA_9" }] },
        { role: "assistant", content: [{ type: "text", text: "Noted codeword ALPHA_9." }] },
        { role: "user", content: [{ type: "text", text: "Now switch to Antigravity and repeat it" }] },
      ] as any,
      { forceFullHistory: true },
    )
    expect(priorOtherModelBlocks).toHaveLength(2)
    expect((priorOtherModelBlocks[0] as any).text).toContain("<conversation_context_from_other_models>")
    expect((priorOtherModelBlocks[0] as any).text).toContain("ALPHA_9")

    const incrementalCatchupBlocks = buildAcpPromptBlocks(
      [
        { role: "user", content: [{ type: "text", text: "First ACP prompt" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "ACP already knows this" }],
          providerOptions: { "antigravity-acp": { acp: true } },
        },
        { role: "user", content: [{ type: "text", text: "Ask OpenCode model BETA_7" }] },
        { role: "assistant", content: [{ type: "text", text: "OpenCode model says BETA_7" }] },
        { role: "user", content: [{ type: "text", text: "Back to ACP now" }] },
      ] as any,
      { forceFullHistory: false },
    )
    expect(incrementalCatchupBlocks).toHaveLength(2)
    expect((incrementalCatchupBlocks[0] as any).text).not.toContain("First ACP prompt")
    expect((incrementalCatchupBlocks[0] as any).text).toContain("BETA_7")
    expect((incrementalCatchupBlocks[1] as any).text).toBe("Back to ACP now")
  })

  test("sanitizes synthetic restart and cross-provider parts safely", () => {
    expect(
      isSyntheticRestartAfterError([
        {
          role: "assistant",
          content: [{ type: "text", text: "Antigravity ACP halted immediately after 1st upstream error" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "The server restarted while you were working. Continue." }],
        },
      ] as any),
    ).toBe(true)

    const nonAcpMsgs = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            name: "acp_bash",
            input: { command: "ls" },
            providerExecuted: true,
            providerMetadata: { "antigravity-acp": { acp: true } },
          },
        ],
      },
    ]
    sanitizeForNonAcpModel(nonAcpMsgs)
    expect(nonAcpMsgs[0].content[0].type).toBe("text")

    const acpMsgs = [
      {
        role: "assistant",
        content: [
          { type: "compaction", text: "Summary" },
          { type: "effort", value: "high" },
        ],
      },
    ]
    sanitizeForAcpModel(acpMsgs)
    expect(acpMsgs[0].content).toHaveLength(1)
    expect(acpMsgs[0].content[0].type).toBe("text")
  })
})
