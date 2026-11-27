import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Argument, CLI, CLIHandler, CommandSpec, IOResult, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-core';
import { SessionProfile } from '@struktoai/mirage-core/policy/profile';
import { MirageExecutionEnv } from '@struktoai/mirage-pi-durable';
import { z } from 'zod';
import { clinicianTool, evaluationProjection, type EvaluationGateway, type OperationInput } from '../agent-runtime';
import { CoreError } from '../platform';

const bytes = new TextEncoder();
const visible = {
  workspace: { file: 'role.json', operation: 'workspace.read', select: (value: unknown) => z.object({ roleId: z.string(), epoch: z.string(), manifest: z.object({ packId: z.string() }) }).parse(value) },
  patients: { file: 'current.json', operation: 'encounter.read', select: (value: unknown) => z.object({ patient: z.object({ name: z.string() }), priorHistory: z.json() }).parse(value) },
  encounters: { file: 'current.json', operation: 'encounter.read', select: (value: unknown) => z.object({ id: z.string(), status: z.string(), version: z.int(), turns: z.array(z.object({ speaker: z.string(), content: z.string() })) }).parse(value) },
  guidelines: { file: 'current.json', operation: 'cds.guidelines', select: (value: unknown) => z.json().parse(value) },
};

export function openMirageEnvironment(gateway: EvaluationGateway) {
  const allowed = new Set(gateway.operations.map(operation => operation.id));
  const mounts = Object.entries(visible).map(([name, view]) => ({ root: `/${name}`, path: `/${name}/${view.file}`, view, ram: new RAMVFS() }));
  const cli = new CLI({ spec: new CommandSpec({ name: 'clinmesh', subcommands: gateway.operations.map(({ id }) => new CommandSpec({ name: id, arguments: [new Argument('input', { type: 'str' })] })) }),
    handlers: Object.fromEntries(gateway.operations.map(({ id, mode }) => [id, new CLIHandler({ write: mode !== 'query', async fn(_accessor, _paths, texts) {
      try {
        const input = z.record(z.string(), z.json()).parse(JSON.parse(texts[0] ?? '{}'));
        return [bytes.encode(JSON.stringify({ data: evaluationProjection(id, await gateway.invoke(id, input)) })), new IOResult()];
      } catch (error) {
        return [bytes.encode(JSON.stringify({ error: error instanceof CoreError ? error.code : 'INVALID_INPUT' })), new IOResult({ exitCode: 1 })];
      }
    } })])) });
  const profile = SessionProfile({ paths: { hide: ['*case-truth*', '*caseTruth*', '*persona*', '*private*', ...mounts.filter(({ view }) => !allowed.has(view.operation)).map(({ root }) => root)] },
    commands: { '*': 'deny', cat: 'allow', ls: 'allow', clinmesh: { '*': 'deny', ...Object.fromEntries([...allowed].map(id => [id, 'allow'])) } } });
  const workspace = new Workspace(Object.fromEntries(mounts.map(({ root, ram }) => [root, [ram, MountMode.READ] as const])), {
    clis: { clinmesh: [cli, null] }, profiles: { [gateway.roleId]: profile }, profile: gateway.roleId, network: false,
  });
  const environment = new MirageExecutionEnv(workspace, { cwd: '/' });
  async function shell(argv: readonly string[]) {
    let stdout = '';
    const line = argv.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
    const response = await environment.exec(line, { timeout: 15000, onOutput(text, _context, { stream }) { if (stream === 'stdout') stdout += text; } }, BACKGROUND_CONTEXT);
    if (!response.ok) throw new CoreError(503, 'MIRAGE_EXECUTION_FAILED');
    return { code: response.value.exitCode, stdout };
  }
  async function inspect(command: 'cat' | 'ls', path: string) {
    if (!['cat', 'ls'].includes(command) || !/^\/(?:[\w-]+(?:\.json)?\/?)*$/.test(path)) throw new CoreError(403, 'MIRAGE_PATH_UNAVAILABLE');
    const mount = mounts.find(item => item.path === path);
    const directory = command === 'ls' && (path === '/' || mounts.some(item => item.root === path));
    if (!mount && !directory) throw new CoreError(403, 'MIRAGE_PATH_UNAVAILABLE');
    if (directory) await gateway.invoke('workspace.read', {});
    if (mount && allowed.has(mount.view.operation)) {
      const id = gateway.encounterId();
      if (mount.view.operation !== 'workspace.read' && !id) throw new CoreError(409, 'EVALUATION_ENCOUNTER_REQUIRED');
      const value = await gateway.invoke(mount.view.operation, mount.view.operation === 'workspace.read' ? {} : { id });
      mount.ram.store.files.set(`/${mount.view.file}`, bytes.encode(JSON.stringify(mount.view.select(value))));
    }
    const result = await shell([command, path]);
    if (result.code !== 0) throw new CoreError(403, 'MIRAGE_PATH_UNAVAILABLE');
    if (path === '/') return result.stdout.split('\n').filter(name => mounts.some(item => item.root === `/${name}`)).join('\n');
    return result.stdout;
  }
  for (const mount of mounts) mount.ram.store.files.set(`/${mount.view.file}`, bytes.encode('{}'));
  const inspectInput = z.strictObject({ command: z.enum(['cat', 'ls']), path: z.string().regex(/^\/(?:[\w.-]+\/?)*$/).max(160) });
  return { inspect, tools: [clinicianTool('mirage_inspect', 'Read visible clinical files under /workspace, /patients, /encounters and /guidelines.', inspectInput, async raw => { const { command, path } = inspectInput.parse(raw); return inspect(command, path); })],
    async invoke(name: string, input: OperationInput) {
      if (!allowed.has(name)) throw new CoreError(403, 'ROLE_FORBIDDEN');
      const result = await shell(['clinmesh', name, JSON.stringify(input)]);
      const parsed = z.union([z.strictObject({ data: z.json() }), z.strictObject({ error: z.string() })]).safeParse(parseOutput(result.stdout));
      if (!parsed.success) throw new CoreError(503, 'MIRAGE_EXECUTION_FAILED');
      if ('error' in parsed.data) throw new CoreError(409, parsed.data.error);
      return parsed.data.data;
    }, close: () => workspace.close() };
}

function parseOutput(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
