import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';

export const limit = 3 * 1024 * 1024;
export function checkBudget(bytes: number) { assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes < limit, `Worker gzip ${bytes} B must be < ${limit} B`); }

export async function uploadMetrics(form: FormData) {
  const metadata = z.object({ main_module: z.string() }).parse(JSON.parse(String(form.get('metadata'))));
  const files = [...form.entries()].filter((item): item is [string, File] => typeof item[1] !== 'string' && item[1].type !== 'application/source-map');
  const main = files.find(([name]) => name === metadata.main_module);
  assert.ok(main, 'Worker entry missing from upload');
  const ordered = [...files.filter(item => item !== main), main];
  for (const [, file] of ordered) {
    assert.doesNotMatch(file.name, /(?:\.node$|\.wasm$|mirage)/i);
    if (file.type.includes('javascript')) assert.doesNotMatch(await file.text(), /better[-_]sqlite3|@struktoai\/mirage/);
  }
  const content = new Blob(ordered.map(([, file]) => file));
  return { modules: ordered.map(([name, file]) => ({ name, bytes: file.size })), raw: content.size, gzip: gzipSync(await content.arrayBuffer()).byteLength };
}

async function audit() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upload-'));
  const events = join(directory, 'wrangler.ndjson');
  try {
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', 'dist/worker-audit', '--outfile', 'dist/worker.bundle', '--metafile', 'dist/worker-meta.json'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: events } });
    const upload = await readFile('dist/worker.bundle');
    const boundary = upload.subarray(2, upload.indexOf('\r\n')).toString();
    const form = await new Response(upload, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }).formData();
    const metrics = await uploadMetrics(form);
    const records: unknown[] = (await readFile(events, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const official = records.flatMap(record => { const result = z.object({ type: z.literal('deploy'), bundle_size: z.object({ raw_bytes: z.int(), gzip_bytes: z.int() }) }).safeParse(record); return result.success ? [result.data.bundle_size] : []; });
    assert.deepEqual(official, [{ raw_bytes: metrics.raw, gzip_bytes: metrics.gzip }]);
    const meta = z.object({ inputs: z.record(z.string(), z.unknown()), outputs: z.record(z.string(), z.object({ inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })) })) }).parse(JSON.parse(await readFile('dist/worker-meta.json', 'utf8')));
    for (const input of Object.keys(meta.inputs)) assert.doesNotMatch(input.replaceAll('\\', '/'), /src\/packages\/mod-agent-mirage\/|@struktoai[/+]mirage|playwright-core|\.wasm$/i);
    const groups = new Map<string, number>();
    for (const output of Object.values(meta.outputs)) for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
      const dependency = path.replaceAll('\\', '/').split('node_modules/').at(-1)!;
      const name = dependency === path ? 'ClinMesh / runtime' : dependency.match(/^(?:@[^/]+\/)?[^/]+/)?.[0] ?? 'other';
      groups.set(name, (groups.get(name) ?? 0) + bytesInOutput);
    }
    console.table(metrics.modules);
    console.table([...groups].sort((left, right) => right[1] - left[1]).slice(0, 14).map(([dependency, bytesInOutput]) => ({ dependency, bytesInOutput })));
    console.log(`Wrangler upload: ${metrics.raw} B raw, ${metrics.gzip} B gzip (independently reproduced; limit < ${limit} B). Dependency contributions are uncompressed esbuild bytesInOutput.`);
    checkBudget(metrics.gzip);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await audit();
