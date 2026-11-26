import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('only permits reviewed native installers in the single-package workspace', () => {
  expect(parse(readFileSync('pnpm-workspace.yaml', 'utf8'))).toEqual({
    allowBuilds: { 'better-sqlite3': true, esbuild: true, workerd: true },
  });
});
