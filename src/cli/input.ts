import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';
import { inputValidator, type OperationDescription } from '../packages/operation-catalog';
import { CliError, invalid } from './errors';

export function parseArguments(argv: string[]) {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (!word.startsWith('--')) { words.push(word); continue; }
    const match = /^--([a-z][a-zA-Z0-9-]*)(?:=(.*))?$/s.exec(word);
    if (!match || flags.has(match[1]!)) invalid('Use each named flag once.');
    const [, name, inline] = match;
    if (name === 'yes' || name === 'json' || name === 'version') {
      if (inline !== undefined) invalid(`--${name} takes no value.`);
      flags.set(name, 'true');
    } else {
      const value = inline ?? argv[++index];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) invalid(`Missing value for --${name}.`);
      flags.set(name!, value);
    }
  }
  const output = flags.get('output') ?? 'json';
  if (!['json', 'table'].includes(output) || (flags.has('json') && output !== 'json')) invalid('Choose --json or --output table.');
  const yes = flags.has('yes');
  const input = flags.get('input');
  const version = flags.has('version');
  for (const flag of ['output', 'json', 'yes', 'input', 'version']) flags.delete(flag);
  return { words, flags, output, yes, input, version };
}

const limit = 1024 * 1024;
async function readJson(stream: AsyncIterable<Buffer | string>) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) invalid('Input exceeds 1 MiB.');
    chunks.push(bytes);
  }
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
  catch { return invalid('Provide one UTF-8 JSON object.'); }
}

async function workspaceInput(source: string) {
  if (source === '-') return readJson(process.stdin);
  const path = source.slice(1);
  if (!source.startsWith('@') || !path || win32.isAbsolute(path) || isAbsolute(path) || /[:\0]/.test(path) || path.split(/[\\/]/).includes('..')) invalid('Use @relative-workspace-file or - for stdin.');
  try {
    const root = await realpath(process.cwd());
    const resolved = await realpath(resolve(root, path));
    const local = relative(root, resolved);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) invalid('Input must stay inside the workspace.');
    const file = await open(resolved, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) invalid('Provide a regular workspace file of at most 1 MiB.');
      return await readJson(file.createReadStream({ autoClose: false }));
    } finally { await file.close(); }
  } catch (error) { if (error instanceof CliError) throw error; return invalid('Cannot read the workspace input file.'); }
}

function scalar(schema: z.ZodType, text: string) {
  if (schema.safeParse(text).success) return text;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) && schema.safeParse(Number(text)).success) return Number(text);
  if (['true', 'false'].includes(text) && schema.safeParse(text === 'true').success) return text === 'true';
  return invalid('Use typed scalar flags or supply structured fields with --input.');
}

export async function operationInput(operation: OperationDescription, args: ReturnType<typeof parseArguments>) {
  const fields = args.input === undefined ? {} : await workspaceInput(args.input);
  const schema = inputValidator(operation);
  const shape: z.ZodRawShape = schema.shape;
  for (const [flag, text] of args.flags) {
    const field = flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!Object.hasOwn(shape, field) || Object.hasOwn(fields, field)) invalid(`Unknown or repeated field --${flag}.`);
    fields[field] = scalar(shape[field] as z.ZodType, text);
  }
  return schema.parse(fields);
}
