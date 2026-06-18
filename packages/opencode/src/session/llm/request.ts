import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { asSchema, jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`
const TOOL_DESCRIPTION_MAX = 800
const SCHEMA_PROSE_KEYS = new Set(["$comment", "default", "deprecated", "description", "examples", "example", "title"])
// Core tools used on nearly every turn. Keep them full so the model never has to
// round-trip through tool_schema before a basic action (esp. bash arg shape).
const KEEP_FULL = new Set(["bash", "read", "edit", "write", "task", "todowrite", "glob", "grep"])

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly toolSchema?: "full" | "compact"
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const resolvedTools = resolveTools(input)
  const tools = input.toolSchema === "compact" ? compactToolsWithReveal(resolvedTools) : resolvedTools
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function compactTools(tools: Record<string, Tool>): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) =>
      KEEP_FULL.has(name)
        ? [name, item]
        : [
            name,
            {
              ...item,
              description: compactDescription(item.description),
              inputSchema: jsonSchema(compactSchema(toolSchema(item.inputSchema))),
            } satisfies Tool,
          ],
    ),
  )
}

export function compactToolsWithReveal(tools: Record<string, Tool>): Record<string, Tool> {
  return {
    ...compactTools(tools),
    tool_schema: toolSchemaReveal(tools),
  }
}

function toolSchemaReveal(tools: Record<string, Tool>): Tool {
  const names = Object.keys(tools).toSorted((a, b) => a.localeCompare(b))
  return aiTool({
    description: "Reveal full description and input schema for an active tool when compact tool schemas omit needed detail.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Active tool name to inspect.",
          enum: names,
        },
      },
      required: ["name"],
    }),
    execute: async (input) => {
      const name = typeof input === "object" && input !== null && "name" in input ? String(input.name) : ""
      const item = tools[name]
      if (!item) {
        return {
          title: "Tool not found",
          metadata: {},
          output: JSON.stringify({ error: "Unknown tool", available: names }, null, 2),
        }
      }
      return {
        title: name,
        metadata: {},
        output: JSON.stringify(
          {
            name,
            description: item.description ?? "",
            inputSchema: toolSchema(item.inputSchema),
          },
          null,
          2,
        ),
      }
    },
  })
}

function compactDescription(value: string | undefined) {
  if (!value) return value
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length <= TOOL_DESCRIPTION_MAX) return compact
  return compact.slice(0, TOOL_DESCRIPTION_MAX - 3).trimEnd() + "..."
}

function toolSchema(value: Tool["inputSchema"]): JSONSchema7 {
  const schema = asSchema(value).jsonSchema
  if (isPromiseLike(schema)) throw new Error("Cannot compact asynchronous tool schema")
  return schema
}

function isPromiseLike(value: unknown): value is PromiseLike<JSONSchema7> {
  return !!value && typeof value === "object" && "then" in value && typeof value.then === "function"
}

// Keys whose VALUES are maps of name -> subschema. Their keys are user-defined
// names (e.g. a property literally named "description"), NOT schema keywords,
// so we must recurse into the values without treating the names as prose keys.
const SCHEMA_NAMED_CHILDREN = new Set(["properties", "patternProperties", "$defs", "definitions"])

// ponytail: hand-walk the schema instead of a blind JSON.stringify replacer.
// A replacer can't tell the schema keyword "description" from a property NAMED
// "description" (e.g. the task tool), and would strip the latter, breaking required.
function compactSchema(value: JSONSchema7): JSONSchema7 {
  if (Array.isArray(value)) return value.map((item) => compactSchema(item as JSONSchema7)) as unknown as JSONSchema7
  if (!value || typeof value !== "object") return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_PROSE_KEYS.has(key)) continue
    if (SCHEMA_NAMED_CHILDREN.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      // Recurse into each subschema but keep the user-defined names verbatim.
      out[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([name, sub]) => [name, compactSchema(sub as JSONSchema7)]),
      )
      continue
    }
    out[key] = compactSchema(child as JSONSchema7)
  }
  return out as JSONSchema7
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
