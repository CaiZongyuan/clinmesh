import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { workerDevArguments } from '../src/server/host-policy';

const wranglerRoot = dirname(createRequire(import.meta.url).resolve('wrangler/package.json'));
const args = workerDevArguments(process.env, process.argv.slice(2));
const child = spawn(process.execPath, [join(wranglerRoot, 'bin', 'wrangler.js'), ...args], { stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', code => { process.exitCode = code ?? 1; });
