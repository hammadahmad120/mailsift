# mailsift

Your mailbox, as documents your AI can actually read. Read-only MCP server that searches mail and returns clean text with attachments extracted.

> Status: early. One tool (`get_mailbox_profile`) over stdio. Search, documents, and HTTP are in progress. See [docs/status.md](docs/status.md) for the phase tracker and [docs/design-brief.md](docs/design-brief.md) for the full design.

## Development

Requires Node 22 or newer for development (runtime target is Node 20+).

```
npm install
npm run check     # lint + typecheck + test
npm run dev       # run from source
npm run build     # build to dist/
```

Copy `.env.example` to `.env` for local configuration. Never commit tokens.

## Run it

```
MAIL_TOKEN=<read-only Gmail access token> npm run dev            # stdio, for Claude Code, Cursor, Inspector
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<token> npx tsx src/index.ts
```

How to get a token and how to add the server to Claude Code: [examples/claude-code.md](examples/claude-code.md). The `--http` transport is not built yet.

## Licence

MIT
