import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('compares nested static frames with their emitted bytes and rejects a nested frame embedded in the worker', () => {
  const root = mkdtempSync(resolve('node_modules/.600-bundle-'));
  const write = (file: string, bytes: string) => writeFileSync(join(root, file), bytes);
  const bytes = 'synthetic-nested-frame-bytes';
  try {
    for (const path of ['assets/clinical-public/clinical-frames', 'dist/client/clinical-frames']) {
      mkdirSync(join(root, path, 'study/sequence'), { recursive: true });
      write(`${path}/study/sequence/key.png`, bytes);
    }
    const chunk = (file: string, modules: string[], dynamicImports: string[]) => ({ file, entry: file === 'main.js', imports: [], dynamicImports, modules });
    const source = 'src/web/modules/imaging/';
    write('dist/browser-chunks.json', JSON.stringify([chunk('main.js', [], ['study.js']), chunk('study.js', [`${source}StudyTab.tsx`], ['canvas.js']), chunk('canvas.js', [`${source}CanvasViewer.tsx`, `${source}viewport.ts`], [])]));
    write('dist/worker-meta.json', JSON.stringify({ outputs: { worker: { inputs: { 'src/server/worker.ts': { bytesInOutput: 1 } } } } }));
    write('dist/worker.bundle', 'worker');
    write('dist/client/main.js', 'main');
    const verify = () => execFileSync(process.execPath, [resolve('scripts/verify-viewer-bundles.ts')], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
    expect(verify()).toContain('0 frame bytes');
    write('dist/worker.bundle', bytes);
    expect(verify).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
