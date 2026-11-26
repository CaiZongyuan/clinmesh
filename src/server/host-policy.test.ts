import { expect, it } from 'vitest';
import { nodeListener, workerDevArguments, workerGatePolicy } from './host-policy';
import { withNodeWorkspace } from '../../scripts/testing/node-workspace';

it('grants local open mode only to a loopback listener chosen at startup', () => {
  expect(nodeListener({ CLINMESH_HOST: 'localhost', CLINMESH_LOCAL_DEV_OPEN: '1' })).toMatchObject({ hostname: '127.0.0.1', localOpen: true });
  expect(nodeListener({ CLINMESH_HOST: '::1', CLINMESH_LOCAL_DEV_OPEN: '1' })).toMatchObject({ hostname: '::1', localOpen: true });
  expect(() => nodeListener({ CLINMESH_HOST: '0.0.0.0', CLINMESH_LOCAL_DEV_OPEN: '1' })).toThrow('LOCAL_OPEN_REQUIRES_LOOPBACK');
  expect(nodeListener({ CLINMESH_HOST: '0.0.0.0' })).toMatchObject({ hostname: '0.0.0.0', localOpen: false });
});

it('opens a new isolated session on the managed Windows Node loopback listener', async () => {
  await withNodeWorkspace(async origin => {
    const gate = await fetch(`${origin}/api/auth/visitor/enter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(gate.status).toBe(200);
    const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: gate.headers.get('set-cookie')!.split(';')[0]! } });
    expect(session.status).toBe(200);
  }, true);
});

it('pins the open Wrangler build to its local listener and leaves hosted Workers on passcode policy', () => {
  expect(workerGatePolicy(false, '1')).toEqual({ localOpen: false });
  expect(workerGatePolicy(true, '1')).toEqual({ localOpen: true });
  expect(workerDevArguments({ CLINMESH_LOCAL_DEV_OPEN: '1' }, [])).toEqual(expect.arrayContaining(['--local', '--ip', '127.0.0.1', '--define', 'CLINMESH_LOOPBACK_WRANGLER:true']));
  expect(() => workerDevArguments({ CLINMESH_LOCAL_DEV_OPEN: '1' }, ['--ip', '0.0.0.0'])).toThrow('LOCAL_OPEN_REQUIRES_MANAGED_LISTENER');
});
