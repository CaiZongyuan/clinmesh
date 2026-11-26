import { z } from 'zod';
import { CoreError } from '../packages/platform';

const listener = z.object({ CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'), CLINMESH_PORT: z.coerce.number().int().min(0).max(65535).optional(), CLINMESH_LOCAL_DEV_OPEN: z.string().optional() });
export function nodeListener(environment: unknown) {
  const configuration = listener.parse(environment);
  const hostname = configuration.CLINMESH_HOST === 'localhost' ? '127.0.0.1' : configuration.CLINMESH_HOST;
  const localOpen = configuration.CLINMESH_LOCAL_DEV_OPEN === '1';
  if (localOpen && hostname !== '127.0.0.1' && hostname !== '::1') throw new CoreError(503, 'LOCAL_OPEN_REQUIRES_LOOPBACK');
  return { hostname, localOpen, port: configuration.CLINMESH_PORT ?? 51868 };
}

export function workerGatePolicy(managedLoopback: boolean, openSetting?: string) { return { localOpen: managedLoopback && openSetting === '1' }; }

export function workerDevArguments(environment: unknown, extra: string[]) {
  const config = listener.parse(environment);
  if (config.CLINMESH_LOCAL_DEV_OPEN !== '1') return ['dev', '--local', ...(config.CLINMESH_PORT === undefined ? [] : ['--port', String(config.CLINMESH_PORT)]), ...extra];
  if (extra.length) throw new CoreError(503, 'LOCAL_OPEN_REQUIRES_MANAGED_LISTENER');
  const { hostname } = nodeListener(config);
  return ['dev', '--local', '--ip', hostname, '--port', String(config.CLINMESH_PORT ?? 8787), '--define', 'CLINMESH_LOOPBACK_WRANGLER:true', '--var', 'CLINMESH_LOCAL_DEV_OPEN:1'];
}
