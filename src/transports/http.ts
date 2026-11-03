import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createServerKeyCheck, requireServerKeys } from '../auth/server-keys.js';
import { isMailError, type ToolErrorBody } from '../errors.js';
import type { Logger } from '../logging.js';
import { SERVER_INFO, createServer, type ServerDeps } from '../server.js';

/**
 * Serve MCP over Streamable HTTP (brief section 6).
 *
 *   POST /mcp      the MCP endpoint. Server key checked first, then a fresh McpServer and a
 *                  stateless transport handle the one request and are closed with the response.
 *   GET  /healthz  open, for Docker HEALTHCHECK and load balancers. Reads nothing from any mailbox.
 *
 * Stateless: no session ids, nothing kept between requests, so any replica can serve any request.
 * Each request carries its own credentials (Authorization for the server, X-Mail-Token for the
 * mailbox); the transport attaches the headers to `extra.requestInfo`, which is what selects the
 * header branch in `resolveCredentials`.
 *
 * Every request gets a request id, returned in `X-Request-Id`, logged on the access line, and
 * carried by the per-request logger into every tool line (`request_id`), so one HTTP request can
 * be joined to the tool call it made.
 */

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';
export const REQUEST_ID_HEADER = 'x-request-id';
/** Tool arguments are small. Express's own default, made explicit. */
export const BODY_LIMIT = '100kb';

interface RequestState {
  id: string;
  log: Logger;
  started: number;
}

function state(res: Response): RequestState {
  return res.locals as unknown as RequestState;
}

function sendError(res: Response, status: number, body: ToolErrorBody): void {
  res.status(status).json(body);
}

/** Builds the Express app. Throws `ConfigError` when `MCP_SERVER_KEYS` is empty (brief section 6). */
export function createHttpApp(deps: ServerDeps): Express {
  const checkServerKey = createServerKeyCheck(requireServerKeys(deps.config));
  const app = express();
  app.disable('x-powered-by');

  // 1. request id, per-request logger, access log line when the response finishes
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = randomUUID();
    const log = deps.logger.child({ request_id: id });
    Object.assign(res.locals, { id, log, started: Date.now() } satisfies RequestState);
    res.setHeader(REQUEST_ID_HEADER, id);
    // originalUrl, not req.path: inside a mounted middleware (the key check) req.path is relative.
    const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
    res.on('finish', () => {
      log.info('http', {
        method: req.method,
        path,
        status: res.statusCode,
        duration_ms: Date.now() - state(res).started,
      });
    });
    next();
  });

  // 2. health, open on purpose (decision 2026-11-02)
  app.get(HEALTH_PATH, (_req, res) => {
    res.json({ status: 'ok', name: SERVER_INFO.name, version: SERVER_INFO.version });
  });

  // 3. server key before anything on /mcp is parsed or handled
  app.use(MCP_PATH, (req, res, next) => {
    try {
      checkServerKey(req.headers);
      next();
    } catch (err) {
      if (!isMailError(err)) {
        next(err);
        return;
      }
      state(res).log.warn('http auth', { code: err.code });
      sendError(res, 401, err.toBody());
    }
  });

  // 4. body, then the transport. One McpServer + one stateless transport per request.
  app.use(MCP_PATH, express.json({ limit: BODY_LIMIT }));
  app.post(MCP_PATH, async (req, res) => {
    const server = createServer({ ...deps, logger: state(res).log });
    // No sessionIdGenerator = stateless. JSON replies instead of event streams (decision 2026-11-02).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's setter-only `onclose`/`onerror` clash with exactOptionalPropertyTypes; the class is a Transport.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body as unknown);
  });
  app.all(MCP_PATH, (_req, res) => {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, {
      code: 'NOT_FOUND',
      message: 'Method not allowed.',
      hint: `Send MCP messages with POST ${MCP_PATH}.`,
    });
  });

  // 5. anything else
  app.use((_req, res) => {
    sendError(res, 404, {
      code: 'NOT_FOUND',
      message: 'No such route.',
      hint: `POST ${MCP_PATH} for MCP, GET ${HEALTH_PATH} for health.`,
    });
  });

  // 6. last line: body-parser failures are 400, everything else 500. Never a stack to the caller.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const parse = err as { type?: string; status?: number };
    if (parse.type === 'entity.parse.failed' || parse.type === 'entity.too.large') {
      sendError(res, parse.status ?? 400, {
        code: 'PROVIDER_ERROR',
        message:
          parse.type === 'entity.too.large'
            ? 'Request body too large.'
            : 'Request body is not JSON.',
        hint: `Send one JSON-RPC message per POST, under ${BODY_LIMIT}.`,
      });
      return;
    }
    state(res).log.error('http unhandled', { error: err });
    sendError(res, 500, { code: 'PROVIDER_ERROR', message: 'Unexpected server error.' });
  });

  return app;
}

export interface HttpOptions {
  port: number;
  /** Default 0.0.0.0: the target is a container. */
  host?: string;
}

/** Builds the app and listens. Resolves once the port is bound; rejects on bind failure. */
export function runHttp(deps: ServerDeps, options: HttpOptions): Promise<Server> {
  const app = createHttpApp(deps);
  const host = options.host ?? '0.0.0.0';
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, host);
    server.once('listening', () => {
      deps.logger.info('http server ready', { host, port: options.port, path: MCP_PATH });
      resolve(server);
    });
    server.once('error', reject);
  });
}
