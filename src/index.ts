/**
 * CLI entry point.
 *
 * Phase 1 will turn this into: `mailsift --stdio` (default) | `mailsift --http`.
 * For now it only proves the toolchain compiles and runs.
 */
export const PACKAGE_NAME = 'mailsift';

export function parseTransportFlag(argv: readonly string[]): 'stdio' | 'http' {
  return argv.includes('--http') ? 'http' : 'stdio';
}

const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isDirectRun && process.env['NODE_ENV'] !== 'test') {
  const transport = parseTransportFlag(process.argv.slice(2));
  console.error(
    `[${PACKAGE_NAME}] environment ok, transport=${transport} (server not implemented yet)`,
  );
}
