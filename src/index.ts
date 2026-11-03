import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './config.js';
import { createLogger } from './logging.js';
import { createDefaultDeps, createServer } from './server.js';
import { runHttp } from './transports/http.js';
import { runStdio, type StdioStreams } from './transports/stdio.js';

/**
 * CLI entry point: `mailsift --stdio` (default) | `mailsift --http`.
 *
 *   --stdio  the client launched us as a child process; credentials from env; lives until stdin closes.
 *   --http   Express on HOST:PORT; credentials per request; lives until SIGTERM/SIGINT or `signal` aborts.
 */
export const PACKAGE_NAME = 'mailsift';

export type TransportName = 'stdio' | 'http';

export function parseTransportFlag(argv: readonly string[]): TransportName {
  return argv.includes('--http') ? 'http' : 'stdio';
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  streams?: StdioStreams;
  /** Where log lines go (JSON, one per line). Defaults to stderr. Never stdout. */
  log?: (line: string) => void;
  /** HTTP mode: abort to close the listener. Production wires SIGTERM/SIGINT to it; tests abort directly. */
  signal?: AbortSignal;
  /** HTTP mode: called with the bound port once listening. Tests use it to find an ephemeral port. */
  onListening?: (address: { host: string; port: number }) => void;
}

/**
 * Returns the process exit code. Resolves once the transport is up (stdio: connected; http: port bound);
 * the process then stays alive on its own until the transport ends.
 */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  // Startup logger: config is not loaded yet, so this one uses the default level.
  const boot = createLogger({ sink: options.log });
  const transport = parseTransportFlag(argv);

  try {
    const deps = createDefaultDeps(options.env ?? process.env, { logSink: options.log });

    if (transport === 'http') {
      const { host, port } = deps.config.http;
      const server = await runHttp(deps, { port, host });
      const bound = server.address();
      const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
      options.onListening?.({ host, port: boundPort });

      const shutdown = (reason: string): void => {
        deps.logger.info('http server stopping', { reason });
        server.close();
        server.closeIdleConnections();
      };
      if (options.signal) {
        if (options.signal.aborted) shutdown('aborted');
        else options.signal.addEventListener('abort', () => shutdown('aborted'), { once: true });
      }
      return 0;
    }

    const server = createServer(deps);
    await runStdio(server, options.streams ?? {});
    deps.logger.info('stdio server ready', { transport, log_level: deps.config.logLevel });
    return 0;
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : 'Failed to start.';
    const fields: Record<string, unknown> = { transport };
    if (!(err instanceof ConfigError)) fields['error'] = err;
    boot.error(message, fields);
    return 1;
  }
}

/** True when this file is the script Node was asked to run, false when it is imported (tests). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // SIGTERM is what Docker, Kubernetes and systemd send on stop; SIGINT is Ctrl-C.
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => controller.abort());
  }
  main(process.argv.slice(2), { signal: controller.signal }).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    () => process.exit(1),
  );
}
