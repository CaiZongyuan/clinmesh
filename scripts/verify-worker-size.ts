import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const upload = readFileSync('dist/worker.bundle');
const boundary = upload.subarray(2, upload.indexOf('\r\n')).toString();
const parts = await new Response(upload, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }).formData();
const modules = [...parts.values()].filter((part): part is File => typeof part !== 'string' && part.type !== 'application/source-map');
if (!modules.length) throw new Error('Wrangler upload contains no Worker modules');
for (const module of modules) {
  if (module.name.endsWith('.node') || (module.type.includes('javascript') && /better[-_]sqlite3/.test(await module.text()))) {
    throw new Error(`Native SQLite dependency in Worker module ${module.name}`);
  }
}
const bytes = gzipSync(await new Blob(modules).arrayBuffer()).byteLength;
const limit = 3 * 1024 * 1024;
console.log(`Gzipped Worker modules: ${bytes} bytes (limit: < ${limit})`);
if (bytes >= limit) process.exitCode = 1;
