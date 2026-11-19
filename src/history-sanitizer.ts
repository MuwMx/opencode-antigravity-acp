import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"
import type { AcpContentBlock } from "./acp-client.js"

export const ACP_PROVIDER_ID = "antigravity-acp"

export const UNSAFE_INTERNAL_SIGNATURE = /\bsession_move\b|tools\.opencode\./i

export const API_ERROR_ABORT_PATTERN =
  /API error \(attempt \d+\)|RESOURCE_EXHAUSTED|Individual quota reached|\(code 429\)|\(code 403\)|PERMISSION_DENIED/i

const ALLOWED_INSTRUCTION_KEYS = new Set([
  "core/instructions",
  "core/skill-guidance",
  "core/mcp-guidance",
  "core/codemode",
])

function truncateText(text: string, maxLen = 6000): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars]`
}

function stringifyCompact(value: unknown, maxLen = 2000): string {
  if (typeof value === "string") return truncateText(value, maxLen)
  try {
    return truncateText(JSON.stringify(value), maxLen)
  } catch {
    return truncateText(String(value), maxLen)
  }
}

function summarizeToolResultValue(result: any): string {
  if (!result || typeof result !== "object") return stringifyCompact(result)
  if (result.type === "content" && Array.isArray(result.value)) {
    return result.value
      .map((item: any) =>
        item?.type === "text"
          ? String(item.text ?? "")
          : `[file ${item?.mime ?? ""} ${item?.name ?? ""}]`,
      )
      .join("\n")
  }
  if ("value" in result) return stringifyCompact(result.value, 6000)
  return stringifyCompact(result, 6000)
}

/**
 * Rewrites Antigravity providerExecuted (hosted) tool calls/results into plain text blocks
 * when a non-Antigravity model runs next, preventing Anthropic/OpenAI protocol serializers
 * from rejecting unfamiliar server-executed tool names.
 */
export function sanitizeForNonAcpModel(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue

    let changed = false
    const nextContent: any[] = []
    for (const part of msg.content) {
      if (!part || typeof part !== "object") {
        nextContent.push(part)
        continue
      }
      const isAcpHosted =
        (part.type === "tool-call" || part.type === "tool-result") &&
        part.providerExecuted === true &&
        (Boolean(part.providerMetadata?.[ACP_PROVIDER_ID]) ||
          String(part.name ?? "").startsWith("acp_"))

      if (isAcpHosted) {
        changed = true
        if (part.type === "tool-call") {
          nextContent.push({
            type: "text",
            text: `[Antigravity tool call \`${part.name}\`: ${stringifyCompact(part.input, 1200)}]`,
          })
        } else {
          nextContent.push({
            type: "text",
            text: `[Antigravity tool \`${part.name}\` result: ${summarizeToolResultValue(part.result)}]`,
          })
        }
        continue
      }
      nextContent.push(part)
    }

    if (changed) {
      const merged = mergeAdjacentTextParts(nextContent)
      messages[i] =
        merged.length > 0
          ? { ...msg, content: merged }
          : { ...msg, content: [{ type: "text", text: "[Antigravity turn completed]" }] }
    }
  }
}

/**
 * Rewrites native compaction parts, effort parts, and provider media refs before
 * OpenCode's AI SDK adapter serializes history into LanguageModelV3Prompt.
 */
export function sanitizeForAcpModel(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || !Array.isArray(msg.content)) continue

    let changed = false
    const nextContent: any[] = []
    for (const part of msg.content) {
      if (!part || typeof part !== "object") {
        nextContent.push(part)
        continue
      }
      if (part.type === "compaction") {
        changed = true
        nextContent.push({
          type: "text",
          text: part.text
            ? `[Prior conversation summary]\n${String(part.text)}`
            : "[Prior conversation checkpoint]",
        })
        continue
      }
      if (part.type === "effort") {
        changed = true
        continue
      }
      if (part.type === "media" && part.media?.source?.type === "ref") {
        changed = true
        nextContent.push({
          type: "text",
          text: `[Provider media ref ${String(part.media.source.provider ?? "")}:${String(part.media.source.id ?? "")}]`,
        })
        continue
      }
      nextContent.push(part)
    }

    if (changed) {
      const merged = mergeAdjacentTextParts(nextContent)
      messages[i] =
        msg.role === "assistant" && merged.length === 0
          ? { ...msg, content: [{ type: "text", text: "[Prior assistant step]" }] }
          : { ...msg, content: merged }
    }
  }
}

function mergeAdjacentTextParts(parts: any[]): any[] {
  const out: any[] = []
  for (const part of parts) {
    const prev = out[out.length - 1]
    if (
      part?.type === "text" &&
      prev?.type === "text" &&
      !part.providerMetadata &&
      !prev.providerMetadata
    ) {
      out[out.length - 1] = {
        ...prev,
        text: `${prev.text}\n${part.text}`,
      }
    } else {
      out.push(part)
    }
  }
  return out
}

export function extractToolResultsFromPrompt(
  prompt: LanguageModelV3Prompt,
  expectedCallIds: ReadonlySet<string>,
): Map<string, { text: string; isError: boolean }> {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role !== "tool" && msg.role !== "assistant") continue
    for (const part of msg.content) {
      if (part.type !== "tool-result") continue
      if (!expectedCallIds.has(part.toolCallId) || results.has(part.toolCallId)) continue
      results.set(part.toolCallId, formatToolResultOutput(part.output))
    }
    if (results.size >= expectedCallIds.size) break
  }
  return results
}

function formatToolResultOutput(output: LanguageModelV3ToolResultOutput): {
  text: string
  isError: boolean
} {
  switch (output.type) {
    case "text":
      return { text: output.value, isError: false }
    case "json":
      return { text: JSON.stringify(output.value), isError: false }
    case "error-text":
      return { text: output.value, isError: true }
    case "error-json":
      return { text: JSON.stringify(output.value), isError: true }
    case "execution-denied":
      return {
        text: output.reason ? `Tool execution denied: ${output.reason}` : "Tool execution denied",
        isError: true,
      }
    case "content": {
      const text = output.value
        .map((c) => {
          if (c.type === "text") return c.text
          if (c.type === "file-data" || c.type === "image-data") {
            const fname = "filename" in c ? c.filename : undefined
            return `[Attachment ${c.mediaType}${fname ? `: ${fname}` : ""}]`
          }
          if (c.type === "file-url" || c.type === "image-url") {
            return `[Attachment URL: ${c.url}]`
          }
          return "[Attachment]"
        })
        .join("\n")
      return { text, isError: false }
    }
    default:
      return { text: stringifyCompact(output), isError: false }
  }
}

function hasAcpMarker(msg: LanguageModelV3Prompt[number]): boolean {
  if (msg.role !== "assistant") return false
  if (msg.providerOptions && ACP_PROVIDER_ID in msg.providerOptions) return true
  return msg.content.some(
    (part) =>
      "providerOptions" in part &&
      part.providerOptions !== undefined &&
      ACP_PROVIDER_ID in part.providerOptions,
  )
}

function formatMessageForCatchUp(msg: LanguageModelV3Prompt[number]): string {
  if (msg.role === "system") return ""
  const chunks: string[] = []
  for (const part of msg.content) {
    if (part.type === "text") {
      if (part.text.trim()) chunks.push(part.text)
    } else if (part.type === "file") {
      chunks.push(`[file ${part.mediaType}${part.filename ? ` ${part.filename}` : ""}]`)
    } else if (part.type === "tool-call") {
      chunks.push(`[tool-call ${part.toolName}(${stringifyCompact(part.input, 800)})]`)
    } else if (part.type === "tool-result") {
      const formatted = formatToolResultOutput(part.output)
      chunks.push(
        `[tool-result ${part.toolName}${formatted.isError ? " ERROR" : ""}: ${truncateText(formatted.text, 2000)}]`,
      )
    }
  }
  if (chunks.length === 0) return ""
  return `[${msg.role.toUpperCase()}]: ${chunks.join("\n")}`
}

function fileDataToBase64(data: Uint8Array | string | URL): string | undefined {
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64")
  }
  if (typeof data === "string") {
    const match = /^data:[^;]+;base64,(.*)$/s.exec(data)
    return match ? match[1] : data
  }
  return undefined
}

/**
 * Extracts only the turns that Antigravity has not yet seen inside its stateful ACP session
 * (any intermediate turns produced by other OpenCode models, plus the latest user message).
 */
export function buildAcpPromptBlocks(
  prompt: LanguageModelV3Prompt,
  options?: { readonly forceFullHistory?: boolean },
): AcpContentBlock[] {
  const nonSystem = prompt.filter((m) => m.role !== "system")
  if (nonSystem.length === 0) {
    return [{ type: "text", text: "Continue." }]
  }

  let lastAcpIdx = -1
  if (!options?.forceFullHistory) {
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (hasAcpMarker(nonSystem[i])) {
        lastAcpIdx = i
        break
      }
    }
  }

  const unseen = nonSystem.slice(lastAcpIdx + 1)
  if (unseen.length === 0) {
    const tail = nonSystem[nonSystem.length - 1]
    const fallback = formatMessageForCatchUp(tail)
    return [{ type: "text", text: fallback || "Continue." }]
  }

  // Last user message is the active turn trigger; everything in `unseen` before it came from other models
  let lastUserIdx = unseen.length - 1
  while (lastUserIdx >= 0 && unseen[lastUserIdx].role !== "user") {
    lastUserIdx--
  }

  const priorMsgs = lastUserIdx > 0 ? unseen.slice(0, lastUserIdx) : lastUserIdx < 0 ? unseen : []
  const currentUserMsg = lastUserIdx >= 0 ? unseen[lastUserIdx] : undefined

  const blocks: AcpContentBlock[] = []
  const catchUpLines = priorMsgs.map(formatMessageForCatchUp).filter(Boolean)
  if (catchUpLines.length > 0) {
    blocks.push({
      type: "text",
      text: `<conversation_context_from_other_models>\n${catchUpLines.join("\n\n")}\n</conversation_context_from_other_models>\n`,
    })
  }

  if (currentUserMsg && currentUserMsg.role === "user") {
    for (const part of currentUserMsg.content) {
      if (part.type === "text") {
        if (part.text.length > 0) {
          blocks.push({ type: "text", text: part.text })
        }
      } else if (part.type === "file") {
        const b64 = fileDataToBase64(part.data)
        if (part.mediaType.startsWith("image/") && b64) {
          blocks.push({ type: "image", data: b64, mimeType: part.mediaType })
        } else {
          blocks.push({
            type: "text",
            text: `[Attached file: ${part.filename ?? "file"} (${part.mediaType})]`,
          })
        }
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "Continue." })
  }
  return blocks
}

/**
 * Removes any line matching internal OpenCode signatures from arbitrary text (prompts or tool metadata).
 */
export function stripUnsafeInternalLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !UNSAFE_INTERNAL_SIGNATURE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Strips OpenCode's internal `opencode` Code Mode namespace (`session_move`, worktrees, etc.)
 * without modifying or obfuscating strings.
 */
export function stripInternalOpencodeNamespace(codemodeText: string): string {
  const lines = codemodeText.split(/\r?\n/)
  const kept: string[] = []
  let skippingNamespace = false

  for (const line of lines) {
    if (skippingNamespace) {
      if (line.startsWith("  ") || line.startsWith("\t")) {
        continue
      }
      skippingNamespace = false
    }

    if (/^- opencode(?:\b|[(:])/.test(line)) {
      skippingNamespace = true
      continue
    }

    if (UNSAFE_INTERNAL_SIGNATURE.test(line)) {
      continue
    }

    kept.push(line)
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Extracts only user-owned workspace context (`AGENTS.md`, skills, MCP guidance, and
 * non-internal Code Mode tool namespaces) from OpenCode's `system` parts.
 */
export function extractSafeAcpContext(systemParts: ReadonlyArray<any>): string {
  const sections: string[] = []

  for (const part of systemParts) {
    const entries = part?.metadata?.experimental?.instructions
    if (!Array.isArray(entries)) continue

    for (const entry of entries) {
      const key = typeof entry?.key === "string" ? entry.key : ""
      if (!ALLOWED_INSTRUCTION_KEYS.has(key)) continue
      const rawText = typeof entry?.text === "string" ? entry.text : ""
      if (!rawText.trim()) continue

      const sectionText =
        key === "core/codemode" ? stripInternalOpencodeNamespace(rawText) : rawText.trim()
      if (sectionText) {
        sections.push(sectionText)
      }
    }
  }

  if (sections.length === 0) return ""

  return stripUnsafeInternalLines(sections.join("\n\n"))
}

/**
 * Detects an OpenCode synthetic auto-resume prompt following a halted API error turn so the
 * bridge does not automatically replay an erroring request on server restart.
 */
export function isSyntheticRestartAfterError(prompt: LanguageModelV3Prompt): boolean {
  const nonSystem = prompt.filter((m) => m.role !== "system")
  if (nonSystem.length === 0) return false

  const last = nonSystem[nonSystem.length - 1]
  if (last.role !== "user") return false

  const lastText = last.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")

  if (!lastText.includes("The server restarted while you were working.")) return false

  for (let i = nonSystem.length - 2; i >= 0; i--) {
    const msg = nonSystem[i]
    if (msg.role !== "assistant") continue
    const assistantText = msg.content
      .filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" && typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("\n")
    return (
      assistantText.includes("Antigravity ACP halted") ||
      API_ERROR_ABORT_PATTERN.test(assistantText)
    )
  }

  return false
}
