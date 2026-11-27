import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import pkg from '../../../package.json';
import { prepareCliPackage } from '../../../scripts/prepare-cli-package';
import { teachingGate, withNodeWorkspace } from '../../../scripts/testing/node-workspace';
import { encounterViewSchema, workspaceSchema } from '../../packages/clinical-core';
import { labViewSchema } from '../../packages/mod-lab';

const bin = resolve(pkg.bin.clinmesh);
const successEnvelope = z.strictObject({ ok: z.literal(true), version: z.literal(1), operation: z.string(), data: z.json() });
const errorEnvelope = z.strictObject({ ok: z.literal(false), type: z.string(), code: z.string(), outcome: z.enum(['not_applied', 'ambiguous_outcome']), message: z.string(), recovery: z.object({ operation: z.literal('command.receipt.get'), input: z.object({ epoch: z.uuidv7(), idempotencyKey: z.string() }) }).optional() });
type Options = { origin?: string; token?: string; stdin?: string; cwd?: string; binPath?: string; env?: NodeJS.ProcessEnv };
async function cli(args: string[], { origin = '', token = '', stdin, cwd, env, binPath = bin }: Options = {}) {
  const child = spawn(process.execPath, [binPath, ...args], { cwd, windowsHide: true, env: { ...process.env, CLINMESH_SERVER_URL: origin, CLINMESH_TOKEN: token, ...env }, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const finished = once(child, 'close');
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  const [code] = await finished;
  return { code, stdout, stderr };
}
function success(reply: Awaited<ReturnType<typeof cli>>, operation: string) {
  expect(reply.stderr).toBe(''); expect(reply.code).toBe(0);
  const envelope = successEnvelope.parse(JSON.parse(reply.stdout));
  expect(envelope.operation).toBe(operation);
  return envelope.data;
}
function rejected(reply: Awaited<ReturnType<typeof cli>>, code: string) {
  expect(reply.stdout).toBe(''); expect(reply.code).toBe(1);
  const error = errorEnvelope.parse(JSON.parse(reply.stderr));
  expect(error.code).toBe(code);
  return error;
}

it('runs the external package bin in node_modules with only the CLI, public contracts, tsx and Zod installed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'clinmesh-cli-package-'));
  try {
    const installed = join(cwd, 'node_modules', 'clinmesh');
    await mkdir(join(installed, 'node_modules'), { recursive: true });
    await prepareCliPackage(installed);
    expect(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).dependencies).toEqual({ tsx: pkg.dependencies.tsx, zod: pkg.dependencies.zod });
    for (const dependency of ['tsx', 'zod']) await symlink(await realpath(`node_modules/${dependency}`), join(installed, 'node_modules', dependency), 'junction');
    const options = { cwd, binPath: join(installed, pkg.bin.clinmesh) };
    expect(success(await cli(['--version'], options), 'cli.version')).toEqual({ packageVersion: pkg.version });
    expect(success(await cli(['operations', 'list'], options), 'operations.list')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'lab.issue' })]));
    expect(success(await cli(['operations', 'schema', 'record.sign'], options), 'operations.schema')).toHaveProperty('outputSchema');
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);

it('discovers offline, prints human tables and rejects invalid and escaping inputs on stderr only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clinmesh-cli-files-'));
  try {
    const cwd = join(dir, 'workspace'); await mkdir(cwd);
    const outside = join(dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'input.json'), '{}');
    await symlink(outside, join(cwd, 'link'), 'junction');
    const oversized = '{}'.padEnd(1024 * 1024 + 1);
    await writeFile(join(cwd, 'large.json'), oversized);
    const schema = success(await cli(['operations', 'schema', 'lab.issue', '--json']), 'operations.schema');
    expect(schema).toMatchObject({ cliPath: 'lab order issue', inputSchema: { required: expect.arrayContaining(['id', 'epoch', 'items']) }, outputSchema: { required: ['version', 'results'] } });
    const list = success(await cli(['operations', 'list', '--json']), 'operations.list');
    expect(JSON.stringify(list)).not.toMatch(/caseTruth|debrief/iu);
    const table = await cli(['operations', 'list', '--output', 'table']);
    expect(table.code).toBe(0); expect(table.stderr).toBe(''); expect(table.stdout).toContain('lab order issue');
    const inputs = ['@../outside/input.json', `@${join(outside, 'input.json')}`, '@link/input.json', '@large.json', '-'];
    for (const input of inputs) rejected(await cli(['encounter', 'list', '--input', input], { cwd, stdin: input === '-' ? oversized : '' }), 'INVALID_INPUT');
    const id = '0191abcd-1111-7000-8000-000000000001';
    rejected(await cli(['command', 'receipt', 'get', '--epoch', id, '--idempotency-key', 'patient-reply:review']), 'INVALID_INPUT');
    rejected(await cli(['lab', 'save-draft', '--input', '-'], { stdin: JSON.stringify({ id, epoch: id, idempotencyKey: 'repeat', expectedVersion: 0, serviceIds: [id, id] }) }), 'INVALID_INPUT');
    rejected(await cli(['record', 'draft', '--expected-version', 'NaN']), 'INVALID_INPUT');
    rejected(await cli(['encounter', 'read', '--id', '../workspace']), 'INVALID_INPUT');
    rejected(await cli(['operations', 'schema', 'encounter.debrief']), 'INVALID_INPUT');
    rejected(await cli(['raw', 'https://example.invalid/']), 'INVALID_INPUT');
    rejected(await cli(['encounter', 'list'], { origin: 'http://example.invalid', token: 'synthetic' }), 'INVALID_CONFIGURATION');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 180_000);

async function enterAndGrant(origin: string) {
  const gate = await fetch(`${origin}/api/auth/visitor/enter`, { method: 'POST', body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  const { epoch } = z.object({ epoch: z.uuidv7() }).parse(await gate.json());
  const headers = { cookie: gate.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' };
  const admin = (path: string, expectedVersion: number, fields: object) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ epoch, idempotencyKey: crypto.randomUUID(), expectedVersion, ...fields }) });
  expect((await admin('/api/workspace/role', 1, { roleId: 'coordinator' })).status).toBe(200);
  const grant = (roleId: string, allowedOperations: string[], ttlSeconds = 600) => admin('/api/workspace/capabilities', 0, { roleId, allowedOperations, ttlSeconds });
  const issued = async (role: string, operations: string[]) => z.object({ token: z.string(), tokenId: z.uuidv7() }).parse(await (await grant(role, operations)).json());
  const intake = await issued('intake', ['workspace.read']);
  const registration = await issued('intake', ['encounter.start']);
  const clinical = ['encounter.read', 'consultation.question', 'record.draft', 'record.sign', 'diagnosis.draft', 'diagnosis.confirm', 'lab.read', 'lab.save-draft', 'lab.issue', 'lab.accept', 'lab.start', 'lab.report-now', 'lab.acknowledge', 'prescription.no-medication', 'encounter.completion', 'encounter.complete', 'command.receipt.get'];
  const clinician = await issued('family-clinician', clinical);
  const other = await issued('family-clinician', ['record.sign']);
  for (const [role, operation] of [['intake', 'lab.issue'], ['family-clinician', 'lab.amend'], ['family-clinician', 'prescription.sign'], ['coordinator', 'capability.issue']]) {
    expect(await (await grant(role!, [operation!])).json()).toEqual({ code: 'INVALID_CAPABILITY_SCOPE' });
  }
  return { epoch, intake, registration, clinician, other, headers, admin };
}

async function lostResponses(origin: string) {
  const counts = new Map<string, number>();
  const received = new Map<string, unknown>();
  const proxy = createServer(async (request, reply) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts).toString();
    const payload: unknown = body && JSON.parse(body);
    const key = body && z.object({ idempotencyKey: z.string() }).parse(payload).idempotencyKey;
    if (key) received.set(key, payload);
    const headers = new Headers({ authorization: request.headers.authorization!, 'content-type': 'application/json' });
    const confirmation = request.headers['x-clinmesh-confirm'];
    if (typeof confirmation === 'string') headers.set('X-ClinMesh-Confirm', confirmation);
    const response = await fetch(origin + request.url, { method: request.method!, headers, body: body || undefined });
    const data = await response.text();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === 'note/ambiguous?' && response.ok) { reply.writeHead(503); reply.end(); }
    else if (key === 'misdirected' && counts.get(key) === 1 && response.ok) { reply.writeHead(421); reply.end(); }
    else if (key === 'diagnosis-disconnect' && response.ok) reply.destroy();
    else { reply.writeHead(response.status, { 'content-type': 'application/json' }); reply.end(data); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  return { origin: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, counts, received, close: () => new Promise<void>(resolve => proxy.close(() => resolve())) };
}

it('completes a native Hono/SQLite outpatient encounter via scoped CLI subprocesses and recovers committed writes without resending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clinmesh-cli-encounter-'));
  try { await withNodeWorkspace(async origin => {
    const { epoch, intake, registration, clinician, other, headers, admin } = await enterAndGrant(origin);
    const proxy = await lostResponses(origin);
    const executed = new Set<string>();
    const run = (command: string, fields?: object, token = clinician.token) => { executed.add(command); return cli(command.split(' '), { origin: proxy.origin, token, cwd: dir, stdin: JSON.stringify(fields) }); };
    const read = async (path: string, id: string) => success(await run(`${path} --id ${id}`), path.replaceAll(' ', '.'));
    const envelope = (expectedVersion: number, idempotencyKey = crypto.randomUUID() as string) => ({ epoch, expectedVersion, idempotencyKey });
    const write = async (path: string, operation: string, id: string, expectedVersion: number, fields: object = {}) => success(await run(`${path} --input - --yes`, { ...envelope(expectedVersion), id, ...fields }), operation);
    const applied = async (reply: Awaited<ReturnType<typeof cli>>, key: string, code: string, operation: string) => {
      const error = rejected(reply, code);
      expect(error).toMatchObject({ outcome: 'ambiguous_outcome', recovery: { operation: 'command.receipt.get', input: { epoch, idempotencyKey: key } } });
      expect(error.message).toContain('command receipt get'); expect(proxy.counts.get(key)).toBe(1);
      const receipt = success(await run('command receipt get --input -', error.recovery!.input), 'command.receipt.get');
      expect(receipt).toMatchObject({ status: 'applied', operation });
      return z.object({ result: z.object({ version: z.int() }) }).parse(receipt).result.version;
    };
    try {
      success(await run('operations list --json'), 'operations.list');
      success(await run('operations schema lab.issue --json'), 'operations.schema');
      const workspace = workspaceSchema.parse(success(await run('workspace read --json', undefined, intake.token), 'workspace.read'));
      await mkdir(join(dir, '.clinmesh'));
      await writeFile(join(dir, '.clinmesh', 'config.json'), JSON.stringify({ serverUrl: proxy.origin, token: intake.token }));
      const profile = { USERPROFILE: dir, HOME: dir, CLINMESH_SERVER_URL: undefined, CLINMESH_TOKEN: undefined };
      expect(success(await cli(['workspace', 'read'], { env: profile }), 'workspace.read')).toMatchObject({ epoch, roleId: 'intake' });
      const patient = workspace.cases.find(item => item.demographics.name === 'Avery Reed')!;
      const start = envelope(0, 'registration');
      const opened = success(await run('encounter start --input - --yes', { ...start, id: patient.id }, registration.token), 'encounter.start');
      expect(success(await run('command receipt get --input -', { epoch, idempotencyKey: start.idempotencyKey }, registration.token), 'command.receipt.get')).toMatchObject({ result: opened });
      const { encounterId: id, version } = z.object({ encounterId: z.uuidv7(), version: z.int() }).parse(opened);
      for (const [operation, path, command, fields] of [
        ['prescription.no-medication', 'no-medication', 'prescription no-medication', { reason: '  \t ' }],
        ['encounter.complete', 'complete', 'encounter complete', { clinicalOverride: { reasonCode: 'specialist-judgment', note: '    ', ruleCodes: ['example'] } }],
      ] as const) {
        const body = { ...envelope(version, `blank-${operation}`), ...fields };
        rejected(await run(`${command} --input - --yes`, { id, ...body }), 'INVALID_INPUT');
        expect(proxy.received.has(body.idempotencyKey)).toBe(false);
        const response = await fetch(`${origin}/api/his/encounters/${id}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${clinician.token}`, 'X-ClinMesh-Confirm': operation }, body: JSON.stringify(body) });
        expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: 'INVALID_INPUT' });
      }
      const content = 'a'.repeat(8000);
      rejected(await cli(['consultation', 'question', '--content', `  ${content}  `, '--input', '-'], { origin: proxy.origin, token: clinician.token, stdin: JSON.stringify({ id, ...envelope(version, 'long-question'), channel: 'text' }) }), 'LLM_PROVIDER_UNCONFIGURED');
      expect(proxy.received.get('long-question')).toMatchObject({ content });
      const cliInput = rejected(await run('record sign --input - --yes', { ...envelope(version), id: 'invalid' }), 'INVALID_INPUT');
      for (const [target, extra] of [['invalid', {}], [id, { id: patient.id }]] as const) {
        const malformed = await fetch(`${origin}/api/his/encounters/${target}/clinical-record/sign`, { method: 'POST', headers: { authorization: `Bearer ${clinician.token}`, 'X-ClinMesh-Confirm': 'record.sign' }, body: JSON.stringify({ ...envelope(version), ...extra }) });
        expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ code: cliInput.code });
      }
      const complete = { ...envelope(version, 'premature'), id };
      rejected(await run('encounter complete --input -', complete), 'CONFIRMATION_REQUIRED');
      expect(proxy.counts.has('premature')).toBe(false);
      rejected(await run('encounter complete --input - --yes', complete), 'COMPLETION_BLOCKED');
      rejected(await run('record sign --input - --yes', complete, intake.token), 'ROLE_FORBIDDEN');
      const unsigned = await fetch(`${origin}/api/his/encounters/${id}/clinical-record/sign`, { method: 'POST', headers: { authorization: `Bearer ${clinician.token}`, 'X-ClinMesh-Confirm': 'diagnosis.confirm' }, body: JSON.stringify(envelope(version)) });
      expect(await unsigned.json()).toEqual({ code: 'CONFIRMATION_REQUIRED' });
      const visit = encounterViewSchema.parse(await read('encounter read', id));
      const fields = Object.fromEntries(visit.template.map(field => [field.id, 'Synthetic teaching observation']));
      await writeFile(join(dir, 'note.json'), JSON.stringify({ fields, epoch, idempotencyKey: 'save-note', expectedDraftVersion: 0 }));
      const draft = z.object({ version: z.int(), draftVersion: z.int() }).parse(success(await run(`record draft --id ${id} --expected-version ${version} --input @note.json`), 'record.draft'));
      const key = 'note/ambiguous?';
      const signed = await applied(await run('record sign --input - --yes', { id, ...envelope(draft.version, key), expectedDraftVersion: draft.draftVersion }), key, 'HTTP_503', 'record.sign');
      rejected(await run('command receipt get --input -', { epoch, idempotencyKey: key }, other.token), 'RECEIPT_NOT_FOUND');
      rejected(await run('command receipt get --input -', { epoch, idempotencyKey: 'unknown' }), 'RECEIPT_NOT_FOUND');
      const diagnoses = [{ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', primary: true }];
      const proposed = z.object({ version: z.int() }).parse(await write('diagnosis draft', 'diagnosis.draft', id, signed, { diagnoses }));
      const confirmed = await applied(await run('diagnosis confirm --input - --yes', { id, ...envelope(proposed.version, 'diagnosis-disconnect') }), 'diagnosis-disconnect', 'NETWORK_FAILURE', 'diagnosis.confirm');
      const lab = async () => labViewSchema.parse(await read('lab read', id));
      const catalog = await lab();
      const service = catalog.services.find(item => item.code === 'cbc')!;
      await write('lab save-draft', 'lab.save-draft', id, catalog.draft.version, { serviceIds: [service.id] });
      const { draft: quote } = await lab();
      const issue = await write('lab order issue', 'lab.issue', id, quote.version, { items: quote.items });
      const { orderId } = z.object({ results: z.array(z.object({ orderId: z.uuidv7() })) }).parse(issue).results[0]!;
      let orderVersion = 1;
      for (const action of ['accept', 'start', 'report-now']) orderVersion = z.object({ version: z.int() }).parse(await write(`lab order ${action}`, `lab.${action}`, orderId, orderVersion)).version;
      const report = (await lab()).orders[0]!.reports[0]!;
      expect(report.acknowledged).toBeNull(); expect(report.observations.length).toBeGreaterThan(0);
      await write('lab report acknowledge', 'lab.acknowledge', report.id, orderVersion, { reportVersion: report.version });
      const medicationVersion = await applied(await run('prescription no-medication --input - --yes', { id, ...envelope(confirmed, 'misdirected'), reason: '  Reviewed for this teaching encounter\t' }), 'misdirected', 'HTTP_421', 'prescription.no-medication');
      expect(proxy.received.get('misdirected')).toMatchObject({ reason: 'Reviewed for this teaching encounter' });
      expect(await read('encounter completion', id)).toMatchObject({ ready: true });
      await write('encounter complete', 'encounter.complete', id, medicationVersion);
      const final = encounterViewSchema.parse(await read('encounter read', id));
      expect(final.status).toBe('completed'); expect(final.recordRevisions).toHaveLength(1); expect(final.diagnosisRevisions).toHaveLength(1);
      const debrief = `${origin}/api/his/encounters/${id}/debrief`;
      expect((await fetch(debrief, { headers: { authorization: `Bearer ${clinician.token}` } })).status).toBe(403);
      expect((await fetch(debrief, { headers })).status).toBe(403);
      expect((await admin(`/api/workspace/capabilities/${clinician.tokenId}/revoke`, 1, {})).status).toBe(200);
      rejected(await run('command receipt get --input -', { epoch, idempotencyKey: key }), 'VISITOR_AUTH_REQUIRED');
      expect((await admin('/api/workspace/role', 2, { roleId: 'family-clinician' })).status).toBe(200);
      expect(await (await fetch(debrief, { headers })).json()).toHaveProperty('caseTruth.primaryDiagnosis');
      const skill = await readFile('skills/clinmesh/SKILL.md', 'utf8');
      for (const match of skill.matchAll(/^clinmesh (.+)$/gm)) expect(executed).toContain(match[1]);
    } finally { await proxy.close(); }
  }); } finally { await rm(dir, { recursive: true, force: true }); }
}, 240_000);
