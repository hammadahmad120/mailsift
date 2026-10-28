# Run mailsift over stdio

stdio is how Claude Code, Cursor, and MCP Inspector run an MCP server: they launch it as a child process and talk JSON-RPC over stdin and stdout. Credentials come from environment variables. Nothing is stored.

## 1. Get a read-only Gmail access token

The quickest way is Google's OAuth Playground. The token lasts about one hour.

1. Open https://developers.google.com/oauthplayground
2. In step 1, find **Gmail API v1** and tick only `https://www.googleapis.com/auth/gmail.readonly`. Click **Authorize APIs** and sign in.
3. In step 2, click **Exchange authorization code for tokens**. Copy the **Access token**.

Only request the read-only scope. The server rejects tokens that carry write scopes (phase 2), and Google itself refuses writes with this token even if the server were bypassed.

For a token that renews itself, use your own Google Cloud OAuth client instead and set the trio `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`. The server then mints access tokens in memory and refreshes them before they expire.

## 2. Try it in MCP Inspector

From the repo root:

```
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<access token> npx tsx src/index.ts
```

Open the URL it prints. Click **Connect**, then **Tools**, then **List Tools**. You should see `get_mailbox_profile` and `search_mail`. Run the first and you get your email address and message count. Then run `search_mail` with a subject word from your own inbox and you get matching messages with links. Paste one `message_id` into `get_email` to read its body.

After `npm run build` the same works with the compiled file:

```
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<access token> node dist/index.js
```

## 3. Add it to Claude Code

One-off, from the command line:

```
claude mcp add mailsift -e MAIL_TOKEN=<access token> -- npx tsx /absolute/path/to/mailsift/src/index.ts
```

Or in a project `.mcp.json`. The `${MAIL_TOKEN}` form reads the variable from your shell at launch, so no token lands in the file:

```json
{
  "mcpServers": {
    "mailsift": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mailsift/src/index.ts"],
      "env": {
        "MAIL_TOKEN": "${MAIL_TOKEN}"
      }
    }
  }
}
```

Then in Claude Code, run `/mcp` to confirm the server is connected and ask: "Check which mailbox is connected and how many messages it has."

Once published, replace the command with `npx mailsift --stdio`.

## Environment variables

| Variable                                                        | Meaning                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `MAIL_PROVIDER`                                                 | `gmail` (default and only option for now)                                          |
| `MAIL_TOKEN`                                                    | Google OAuth access token with the `gmail.readonly` scope                          |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Optional. Used instead of `MAIL_TOKEN` to mint and refresh access tokens in memory |

Limits and other settings are listed in `.env.example`.

## Never write to stdout

stdout is the protocol channel. A stray `console.log` corrupts the connection and the client disconnects with a parse error. The server logs to stderr only, and eslint turns `console.log` into an error.
