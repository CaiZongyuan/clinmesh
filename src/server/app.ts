import { Hono } from 'hono';
import { z } from 'zod';
import { permitsProviderKey } from '../packages/agent-protocol';
import { CoreError, createVisitorGate, ModuleRegistry, type ClinMeshModule, type Credential, type GateSettings, type OperationCatalog, type RuntimeHealth } from '../packages/platform';
import { handleError } from './workspace';

export type Dispatch = (request: Request, credential: Credential, entering: boolean) => Promise<Response> | Response;
export function createApp(runtime: RuntimeHealth['runtime'], settings: GateSettings, dispatch: Dispatch, modules: readonly ClinMeshModule<OperationCatalog>[] = []) {
  const app = new Hono();
  app.onError(handleError);
  const registry = new ModuleRegistry(modules);
  app.get('/api/health', context => context.json(registry.health(runtime)));
  app.on('ALL', ['/api/*', '/fhir/R5', '/fhir/R5/*'], async context => {
    const request = context.req.raw;
    const origin = new URL(request.url);
    const gate = createVisitorGate({ ...settings, localOpen: settings.localOpen && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) });
    const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${origin.protocol === 'https:' ? '; Secure' : ''}`;
    const crossSite = request.headers.get('origin');
    const checkOrigin = () => { if (!['GET', 'HEAD'].includes(request.method) && crossSite && crossSite !== origin.origin) throw new CoreError(403, 'ORIGIN_FORBIDDEN'); };
    if (origin.pathname === '/api/auth/visitor/enter' && request.method === 'POST') {
      checkOrigin();
      const { passcode } = z.strictObject({ passcode: z.string().max(1024).default('') }).parse(await request.json());
      const { ticket, token } = await gate.enter(passcode);
      const response = await dispatch(new Request(request.url, { method: 'POST' }), { ticket }, true);
      const result = new Response(response.body, response);
      if (result.ok) result.headers.set('set-cookie', `cm_visitor=${token}; Max-Age=86400; ${cookieFlags}`);
      result.headers.set('cache-control', 'no-store');
      return result;
    }
    const credential = await gate.authenticate(context.req.header('cookie'), context.req.header('authorization'));
    if (request.headers.has('X-ClinMesh-LLM-Api-Key') && !permitsProviderKey(origin)) throw new CoreError(400, 'LLM_HTTPS_REQUIRED');
    checkOrigin();
    const response = await dispatch(request, credential, false);
    const result = new Response(response.body, response);
    result.headers.set('cache-control', 'no-store');
    if (origin.pathname === '/api/auth/logout' && result.ok) result.headers.set('set-cookie', `cm_visitor=; Max-Age=0; ${cookieFlags}`);
    return result;
  });
  return app;
}
