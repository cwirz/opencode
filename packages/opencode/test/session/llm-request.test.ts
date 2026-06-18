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
