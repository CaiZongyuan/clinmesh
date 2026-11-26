import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const teachingGate = { CLINMESH_VISITOR_PASSCODE: 'synthetic-example' };
export async function withNodeWorkspace(run: (origin: string) => Promise<void>, localOpen = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-core-http-'));
  try { await withNodeDatabase(join(directory, 'test.sqlite'), run, localOpen); } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function withNodeDatabase(dbPath: string, run: (origin: string) => Promise<void>, localOpen = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/node-server.ts'], {
    windowsHide: true, env: { ...process.env, ...teachingGate, CLINMESH_SESSION_SECRET: '', CLINMESH_LOCAL_DEV_OPEN: localOpen ? '1' : '0', CLINMESH_PORT: '0', CLINMESH_HOST: '127.0.0.1', CLINMESH_DATABASE_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  try {
    const port = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', data => { const match = String(data).match(/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]!); });
      child.once('exit', code => reject(Error(`Node workspace exited (${code})`)));
      child.once('error', reject);
    });
    await run(`http://127.0.0.1:${port}`);
  } finally { child.kill(); await closed; }
}
