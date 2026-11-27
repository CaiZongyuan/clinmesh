import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { OperationDescription } from '../packages/operation-catalog';
import pkg from '../../package.json' with { type: 'json' };
import { CliError, invalid } from './errors';
import { operationInput, parseArguments } from './input';
import { callOperation } from './transport';

async function run() {
  const args = parseArguments(process.argv.slice(2));
  const operations: OperationDescription[] = JSON.parse(await readFile(new URL('./operations.json', import.meta.url), 'utf8'));
  const path = args.words.join(' ');
  let operation: string;
  let data: unknown;
  if (args.version) {
    if (args.words.length || args.flags.size || args.input !== undefined || args.yes) invalid('Use --version on its own.');
    operation = 'cli.version'; data = { packageVersion: pkg.version };
  } else if (args.words[0] === 'operations') {
    if (args.flags.size || args.input !== undefined || args.yes) invalid('Discovery accepts only output options.');
    if (path === 'operations list') {
      operation = 'operations.list'; data = operations.map(({ inputSchema: _input, outputSchema: _output, ...metadata }) => metadata);
    } else if (args.words[1] === 'schema' && args.words.length === 3) {
      operation = 'operations.schema';
      const entry = operations.find(item => item.id === args.words[2]);
      if (!entry) invalid('Unknown operation ID. Use operations list.');
      data = entry;
    } else invalid('Use operations list or operations schema <id>.');
  } else {
    const entry = operations.find(item => item.cliPath === path);
    if (!entry) invalid('Unknown command. Use operations list.');
    if (entry.risk === 'high-risk-write' && !args.yes) throw new CliError('input', 'CONFIRMATION_REQUIRED', 'Review the formal operation and supply --yes to confirm.');
    operation = entry.id;
    data = await callOperation(entry, await operationInput(entry, args), args.yes);
  }
  if (args.output === 'json') process.stdout.write(`${JSON.stringify({ ok: true, version: 1, operation, data })}\n`);
  else if (operation === 'operations.list') console.table(data, ['id', 'cliPath', 'mode', 'risk', 'moduleId', 'visitorOnly']);
  else console.table(data);
}

try { await run(); }
catch (error) {
  const failure = error instanceof CliError ? error : error instanceof z.ZodError ? new CliError('input', 'INVALID_INPUT', 'Input does not match the operation schema.') : new CliError('protocol', 'CLI_ERROR', 'Unable to complete the command.');
  process.stderr.write(`${JSON.stringify(failure.envelope())}\n`);
  process.exitCode = 1;
}
