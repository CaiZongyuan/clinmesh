import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import pkg from '../package.json';

it('builds and starts the production Node server with only required packages, treats a patient and refuses absent experimental arms before allocating storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-required-packages-'));
  try {
    for (const path of ['package.json', 'vite.config.ts', 'tsconfig.json', 'scripts/prepare-teaching-frames.ts', 'src', 'data']) await cp(path, join(root, path), { recursive: true });
    for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
      const target = join(root, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(`node_modules/${name}`), target, 'junction');
    }
    for (const name of Object.keys(pkg.optionalDependencies)) await expect(stat(join(root, 'node_modules', name))).rejects.toMatchObject({ code: 'ENOENT' });
    execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--ssr', 'src/server/node-server.ts', '--outDir', 'dist/server'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    const dbPath = join(root, 'clinic.sqlite');
    const child = spawn(process.execPath, ['dist/server/node-server.js'], { cwd: root, windowsHide: true, env: { ...process.env, CLINMESH_LOCAL_DEV_OPEN: '1', CLINMESH_VISITOR_PASSCODE: '', CLINMESH_HOST: '127.0.0.1', CLINMESH_PORT: '0', CLINMESH_DATABASE_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      const origin = await new Promise<string>((ready, reject) => {
        child.stdout.on('data', chunk => { const match = String(chunk).match(/127\.0\.0\.1:\d+/); if (match) ready(`http://${match[0]}`); });
        child.once('error', reject); child.once('exit', code => reject(Error(`Node exited ${code}`)));
      });
      const enter = await fetch(`${origin}/api/auth/visitor/enter`, { method: 'POST', body: '{}' });
      const { epoch } = z.object({ epoch: z.uuidv7() }).parse(await enter.json());
      const headers = { cookie: enter.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' };
      const post = (path: string, payload: object) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(payload) });
      expect((await post('/api/workspace/role', { epoch, expectedVersion: 1, idempotencyKey: crypto.randomUUID(), roleId: 'family-clinician' })).status).toBe(200);
      const workspace = z.object({ cases: z.array(z.object({ id: z.string() })).min(1) }).parse(await (await fetch(`${origin}/api/workspace`, { headers })).json());
      const start = await post(`/api/his/cases/${workspace.cases[0]!.id}/start-encounter`, { epoch, expectedVersion: 0, idempotencyKey: crypto.randomUUID() });
      const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await start.json());
      expect(await (await fetch(`${origin}/api/his/encounters/${encounterId}`, { headers })).json()).toMatchObject({ status: 'active', responsibleRole: 'family-clinician' });
      for (const arm of ['mirage-vfs', 'ui-sdk-webmcp']) {
        const response = await post('/api/eval/runs', { arm, packId: 'global-general', caseId: 'g01', maxTurns: 1, clinicianModel: 'tested', patientModel: 'patient' });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: 'EVALUATION_ARM_UNAVAILABLE', arm });
      }
      await expect(stat(dbPath + '.evaluations')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { child.kill(); await closed; }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90000);
