# Call mailsift over HTTP with curl

The HTTP transport serves MCP at `POST /mcp`. Every request carries two credentials:

| Header                               | What it is                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `Authorization: Bearer <server key>` | One of the keys in the server's `MCP_SERVER_KEYS`. Proves you may use it.      |
| `X-Mail-Token: <access token>`       | A Google OAuth access token with the read-only Gmail scope. This request only. |

Optional: `X-Mail-Provider: gmail` (the default). The server never reads a mailbox token from its own environment over HTTP; if `X-Mail-Token` is missing the tool answers `AUTH_MISSING_TOKEN`.

MCP requires `Accept: application/json, text/event-stream` on every POST. mailsift answers with plain JSON.

## Start the server

From the repo root, in development:

```
MCP_SERVER_KEYS=dev-key PORT=3000 HOST=127.0.0.1 npm run dev -- --http
```

After `npm run build`, or from the npm package:

```
MCP_SERVER_KEYS=dev-key node dist/index.js --http
```

`HOST` defaults to `0.0.0.0`, which is right for a container and reachable from your local network on a laptop; `127.0.0.1` keeps it local. Ctrl-C or `SIGTERM` stops it after in-flight requests finish.

With Docker:

```
docker build -t mailsift .
docker run --rm -e MCP_SERVER_KEYS=dev-key -p 3000:3000 mailsift
```

## Health, no credentials

```
curl -s http://localhost:3000/healthz
```

```json
{ "status": "ok", "name": "mailsift", "version": "0.1.0" }
```

## Variables for the calls below

```
export KEY=dev-key
export TOKEN=<Gmail read-only access token>
```

## Initialize

```
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Stateless: there is no session id to keep, and every later request stands on its own.

## List tools

```
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Call a tool

```
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "X-Mail-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_mailbox_profile","arguments":{}}}'
```

A search:

```
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "X-Mail-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_mail","arguments":{"subject":"invoice","page_size":5}}}'
```

## What failures look like

| Situation               | HTTP | Body                                                     |
| ----------------------- | ---- | -------------------------------------------------------- |
| No or wrong server key  | 401  | `{ "code": "AUTH_SERVER_KEY", ... }`                     |
| No `X-Mail-Token`       | 200  | tool result with `isError: true`, `AUTH_MISSING_TOKEN`   |
| Token with write scopes | 200  | tool result with `isError: true`, `AUTH_SCOPE_TOO_BROAD` |
| Body is not JSON        | 400  | `{ "code": "PROVIDER_ERROR", ... }`                      |
| `GET /mcp`              | 405  | `{ "code": "NOT_FOUND", ... }`, `Allow: POST`            |
| Unknown path            | 404  | `{ "code": "NOT_FOUND", ... }`                           |

Tool failures are MCP results, not HTTP errors, because the model on the other end reads them and decides what to do next.

## Logs

The server writes one JSON line per request to stderr (`msg: "http"`, method, path, status, duration) and one per tool call (`msg: "tool"`). Both carry the same `request_id`, which is also returned in the `X-Request-Id` response header. Tokens and keys never appear in them.
