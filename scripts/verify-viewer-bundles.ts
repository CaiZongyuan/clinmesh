import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';

const paths = z.array(z.string());
const chunks = z.array(z.object({ file: z.string(), entry: z.boolean(), imports: paths, dynamicImports: paths, modules: paths })).parse(JSON.parse(readFileSync('dist/browser-chunks.json', 'utf8')));
const chunkFor = (name: string) => {
  const owners = chunks.filter(chunk => chunk.modules.includes(`src/web/modules/imaging/${name}`));
  assert.equal(owners.length, 1, `Expected one production chunk for ${name}`);
  return owners[0]!;
};
const viewer = chunkFor('CanvasViewer.tsx');
const panel = chunkFor('StudyTab.tsx');
assert.equal(chunkFor('viewport.ts').file, viewer.file);
assert.notEqual(viewer.file, panel.file);
assert.ok(panel.dynamicImports.includes(viewer.file));
const initial = new Set(chunks.filter(chunk => chunk.entry).map(chunk => chunk.file));
for (const file of initial) for (const name of chunks.find(chunk => chunk.file === file)!.imports) initial.add(name);
assert.ok([...initial].some(file => chunks.find(chunk => chunk.file === file)!.dynamicImports.includes(panel.file)));
assert.ok(!initial.has(panel.file) && !initial.has(viewer.file));
for (const chunk of chunks.filter(chunk => initial.has(chunk.file))) assert.ok(!chunk.modules.some(path => /src\/(?:web\/modules\/imaging|packages\/(?:diagnostic-studies|mod-imaging|mod-pathology))\//.test(path)));
const meta = z.object({ outputs: z.record(z.string(), z.object({ inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })) })) }).parse(JSON.parse(readFileSync('dist/worker-meta.json', 'utf8')));
const workerInputs = Object.values(meta.outputs).flatMap(output => Object.entries(output.inputs).flatMap(([path, contribution]) => contribution.bytesInOutput > 0 ? [path.replaceAll('\\', '/')] : []));
assert.ok(workerInputs.some(path => path.endsWith('src/server/worker.ts')));
const generator = 'scripts/prepare-teaching-frames.ts';
assert.ok(!workerInputs.some(path => path.includes('src/web/') || path.includes('assets/clinical-public/') || path.endsWith(generator)));
assert.ok(!chunks.some(chunk => chunk.modules.some(path => path.endsWith(generator))));
const worker = readFileSync('dist/worker.bundle');
const frameRoot = 'assets/clinical-public/clinical-frames';
for (const entry of readdirSync(frameRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const source = join(entry.parentPath, entry.name);
  const image = readFileSync(source);
  assert.deepEqual(readFileSync(join('dist/client/clinical-frames', relative(frameRoot, source))), image);
  assert.ok(!worker.includes(image) && !worker.includes(image.toString('base64')));
  for (const file of initial) assert.ok(!readFileSync(`dist/client/${file}`).includes(image.toString('base64')));
}
console.log(`Viewer isolated: ${[...initial].join(', ')} -> lazy ${panel.file} -> lazy ${viewer.file}. Worker: 0 browser inputs, 0 frame bytes.`);
