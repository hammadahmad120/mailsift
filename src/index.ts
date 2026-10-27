import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './config.js';
import { createDefaultDeps, createServer } from './server.js';
import { runStdio, type StdioStreams } from './transports/stdio.js';

/**
 * CLI entry point: `mailsift --stdio` (default) | `mailsift --http`.
 * The HTTP transport arrives in phase 5; until then `--http` exits with a message.
 */
export const PACKAGE_NAME = 'mailsift';

export type TransportName = 'stdio' | 'http';

export function parseTransportFlag(argv: readonly string[]): TransportName {
  return argv.includes('--http') ? 'http' : 'stdio';
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  streams?: StdioStreams;
  /** Where diagnostics go. Defaults to stderr. Never stdout. */
  log?: (line: string) => void;
}

/** Returns the process exit code. Only returns early on error; in stdio mode the transport keeps the process alive. */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const transport = parseTransportFlag(argv);

  if (transport === 'http') {
    log(`[${PACKAGE_NAME}] --http is not implemented yet (phase 5). Run with --stdio.`);
    return 1;
  }

  try {
    const deps = createDefaultDeps(options.env ?? process.env);
    const server = createServer(deps);
    await runStdio(server, options.streams ?? {});
    log(`[${PACKAGE_NAME}] stdio server ready`);
    return 0;
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : 'Failed to start.';
    log(`[${PACKAGE_NAME}] ${message}`);
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
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    () => process.exit(1),
  );
}
