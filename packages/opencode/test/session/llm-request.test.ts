import { describe, expect, test } from "bun:test"
import { asSchema, jsonSchema, tool } from "ai"
import { compactTools, compactToolsWithReveal } from "@/session/llm/request"

describe("LLM request prep", () => {
  test("compactTools strips schema prose and truncates descriptions", () => {
    const execute = async () => ({ output: "", title: "", metadata: {} })
    const tools = compactTools({
      sample: tool({
        description: "A".repeat(900),
        inputSchema: jsonSchema({
          type: "object",
          title: "Sample input",
          description: "Root prose",
          properties: {
            path: {
              type: "string",
              description: "Path prose",
              enum: ["a", "b"],
            },
          },
          required: ["path"],
        }),
        execute,
      }),
    })

    expect(tools.sample.description).toHaveLength(800)
    expect(tools.sample.execute).toBe(execute)
    expect(asSchema(tools.sample.inputSchema).jsonSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          enum: ["a", "b"],
        },
      },
      required: ["path"],
    })
  })

  test("compactTools keeps a property literally named description", () => {
    // Regression: the task tool has a required property NAMED "description".
    // The compactor must strip schema-keyword prose but keep property names.
    // Use a non-core tool name so compaction actually runs (task is kept full).
    const tools = compactTools({
      mcp_thing: tool({
        description: "Launch a subagent",
        inputSchema: jsonSchema({
          type: "object",
          description: "Root prose",
          properties: {
            description: { type: "string", description: "param prose" },
            prompt: { type: "string" },
          },
          required: ["description", "prompt"],
        }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      }),
    })

    expect(asSchema(tools.mcp_thing.inputSchema).jsonSchema).toEqual({
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["description", "prompt"],
    })
  })

  test("compactTools keeps core tools (bash) full", () => {
    const longDesc = "B".repeat(900)
    const tools = compactTools({
      bash: tool({
        description: longDesc,
        inputSchema: jsonSchema({
          type: "object",
          properties: { command: { type: "string", description: "the command" } },
          required: ["command"],
        }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      }),
    })

    expect(tools.bash.description).toBe(longDesc)
    expect(asSchema(tools.bash.inputSchema).jsonSchema).toEqual({
      type: "object",
      properties: { command: { type: "string", description: "the command" } },
      required: ["command"],
    })
  })

  test("compactToolsWithReveal exposes full schema on demand", async () => {
    const tools = compactToolsWithReveal({
      sample: tool({
        description: "Full tool details",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "Full field prose" },
          },
        }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      }),
    })

    const result = await tools.tool_schema.execute!({ name: "sample" }, { toolCallId: "test", messages: [] })
    const output = JSON.parse(typeof result === "string" ? result : result.output)

    expect(output).toEqual({
      name: "sample",
      description: "Full tool details",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Full field prose" },
        },
      },
    })
  })
})
