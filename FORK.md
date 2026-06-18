# About this fork

This is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode).
It tracks upstream and appends `-cwirz` to the version (e.g. `1.17.8-cwirz`).

It adds three things on top of stock OpenCode. The two features are opt-in and
inert unless enabled — with them unset, this behaves like upstream.

## 1. Compact tool schemas — `experimental.tool_schema: "compact"`

Strips prose (descriptions, examples, titles) from tool JSON schemas and caps
tool descriptions at 800 chars before they're sent to the provider. A synthetic
`tool_schema` tool is injected so the agent can fetch the full description and
schema for any tool on demand. On a heavy MCP setup this reclaims tens of
thousands of context tokens per request.

```jsonc
// ~/.config/opencode/opencode.json
{ "experimental": { "tool_schema": "compact" } }
```

Default is `"full"` (unchanged upstream behavior).

## 2. Lazy MCP tool loading — `experimental.mcp_lazy` + `mcp.<server>.lazy`

Connects MCP servers normally but withholds their tools from the model until
needed. A short hint lists the deferred servers and their tool counts; the agent
calls the injected `mcp_load` tool to activate a server's tools for the session.
Use it for heavy servers you only touch occasionally while keeping always-used
ones eager.

```jsonc
// ~/.config/opencode/opencode.json
{
  "experimental": { "mcp_lazy": true },
  "mcp": {
    "chrome-devtools": { "lazy": true },
    "gitlab":          { /* eager — no lazy flag */ }
  }
}
```

## 3. Shared session database (fork-only)

Stock OpenCode gives local/source builds their own `opencode-<channel>.db`, so a
non-official binary starts with an empty session list. This fork makes the
`local` channel read the same `opencode.db` as the official app, so existing
sessions carry over.

**Caveat:** both binaries then share one SQLite file. Safe as long as this fork
stays on the same upstream version as the installed official app (same schema;
WAL + busy_timeout handle concurrent access). If a future upstream merge changes
DB migrations, whichever app opens the file first migrates it — keep versions
aligned. This change is intentionally **not** sent upstream; it only makes sense
for a distributed fork.

## Install

Via Homebrew (macOS, Apple Silicon):

```sh
brew install cwirz/opencode/opencode-cwirz
```

Installs as `opencode-cwirz`, coexisting with the official `opencode`. See the
[tap repo](https://github.com/cwirz/homebrew-opencode) for updates and the
release process.
