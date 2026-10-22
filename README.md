# mailsift

Your mailbox, as documents your AI can actually read. Read-only MCP server that searches mail and returns clean text with attachments extracted.

> Status: environment set up, server not implemented yet. See [docs/status.md](docs/status.md) for the phase tracker and [docs/design-brief.md](docs/design-brief.md) for the full design.

## Development

Requires Node 22 or newer for development (runtime target is Node 20+).

```
npm install
npm run check     # lint + typecheck + test
npm run dev       # run from source
npm run build     # build to dist/
```

Copy `.env.example` to `.env` for local configuration. Never commit tokens.

## Licence

MIT
