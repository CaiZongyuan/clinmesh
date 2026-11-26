import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const guard = resolve(import.meta.dirname, 'lint-boundaries.ts');
const legalGraph: Record<string, string> = {
  'packages/store/lib/value': 'export type Value = number;',
  'packages/store/index': "export type { Value } from './lib/value';",
  'packages/store/tests/read': "export type { Value } from '../index';",
  'packages/mod-lab/index': "export type { Value } from '../store';",
  'packages/mod-example/index': 'export {};',
  'server/app': "import '../packages/mod-lab';",
  'web/main': "import '../packages/store';",
};

it.each([
  ['entrypoint-boundary-from-app', 'server/app', "import '../packages/store/lib/value'"],
  ['entrypoint-boundary-across-packages', 'packages/mod-lab/index', "export type { Value } from '../store/lib/value'"],
  ['entrypoint-boundary-across-packages', 'packages/mod-lab/index', "export type { Value } from '@packages/store/lib/value'"],
  ['tests-through-entrypoints', 'packages/store/tests/read', "export type { Value } from '../lib/value'"],
  ['tests-folder-is-private', 'packages/store/lib/other', "import '../tests/read'"],
  ['no-server-importing-web', 'server/app', "void import('../web/main')"],
  ['no-web-importing-server', 'web/main', "import '../server/app'"],
  ['core-never-imports-modules', 'packages/store/index', "import '../mod-example'"],
  ['no-circular', 'packages/store/lib/value', "import '../index'; export type Value = number"],
])('%s accepts the legal graph and rejects the forbidden edge', (rule, source, illegal) => {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.clinmesh-graph-'));
  const writeModule = (path: string, code: string) => {
    const target = join(directory, 'src', `${path}.ts`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
  };
  const lint = () => spawnSync(process.execPath, [guard], { cwd: directory, encoding: 'utf8' });
  try {
    mkdirSync(join(directory, 'scripts'));
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@packages/*': ['src/packages/*'] } }, include: ['src'],
    }));
    for (const [path, code] of Object.entries(legalGraph)) writeModule(path, code);
    const legal = lint();
    expect(legal.status, legal.stderr + legal.stdout).toBe(0);
    writeModule(source, illegal);
    const violation = lint();
    expect(violation.status).toBe(1);
    expect(violation.stdout + violation.stderr).toContain(rule);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
