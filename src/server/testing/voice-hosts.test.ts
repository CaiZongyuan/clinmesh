import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { workspaceSchema } from '../../packages/clinical-core';
import { createNodeSqliteStore } from '../../packages/store';
import { createNodeApp } from '../node-app';
import { connectNodeVoice } from '../node-voice';
import { hostKey, scriptedBailian, visitorKey } from './voice-provider';

async function setup(origin: string) {
  const enter = await fetch(origin + '/api/auth/visitor/enter', { method: 'POST', body: JSON.stringify({ passcode: 'synthetic-example' }) });
  const cookie = enter.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { cookie, 'content-type': 'application/json' };
  const workspace = workspaceSchema.parse(await (await fetch(origin + '/api/workspace', { headers })).json());
  const command = (path: string, expectedVersion: number, fields: object) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion, idempotencyKey: crypto.randomUUID(), ...fields }) });
  const target = workspace.cases.find(item => item.demographics.name === 'Avery Reed')!;
  const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await (await command(`/api/his/cases/${target.id}/start-encounter`, 0, {})).json());
  const path = `/api/voice/session?${new URLSearchParams({ epoch: workspace.epoch, encounterId })}`;
  const read = () => fetch(origin + path, { headers });
  expect((await fetch(origin + path)).status).toBe(401);
  const initialStatus = (await read()).status;
  expect((await command('/api/workspace/role', 1, { roleId: 'family-clinician' })).status).toBe(200);
  return { workspace, path, cookie, read, initialStatus };
}
function exchange(url: string, cookie: string, first: object) {
  const origin = new URL(url).origin;
  const socket = new WebSocket(url.replace('http:', 'ws:'), { headers: { cookie }, origin });
  socket.binaryType = 'arraybuffer';
  const frames: unknown[] = [];
  socket.once('open', () => socket.send(JSON.stringify(first)));
  socket.on('message', (data, binary) => {
    if (binary && data instanceof ArrayBuffer) { const bytes = new DataView(data); frames.push([bytes.byteLength, bytes.getUint32(4, true), bytes.getUint32(40, true)]); return; }
    const frame = JSON.parse(data.toString()); frames.push(frame);
    if (frame.type === 'listening') socket.send(new Int16Array(1600).fill(-1600));
    if (frame.type === 'final') socket.send(JSON.stringify({ type: 'finish' }));
  });
  return once(socket, 'close').then(() => frames);
}
async function exercise(origin: string) {
  const { workspace, path, cookie, read, initialStatus } = await setup(origin);
  expect(workspace.enabledModules).toContain('mod-voice');
  expect(initialStatus).toBe(403); expect((await read()).status).toBe(426);
  expect(await exchange(origin + path, cookie, { type: 'listen', token: visitorKey })).toEqual([
    { type: 'listening' }, { type: 'partial', text: 'A teaching' }, { type: 'final', text: 'A teaching question.' }, { type: 'done' },
  ]);
  expect(await exchange(origin + path, cookie, { type: 'speak', text: 'A teaching reply.' })).toEqual([[46, 38, 2], { type: 'done' }]);
  expect(await exchange(origin + path, cookie, { type: 'speak', token: visitorKey, text: 'A teaching reply.' })).toEqual([{ type: 'error', code: 'VOICE_AUTH_FAILED' }]);
  return workspace.workspaceId;
}

it('runs binary speech sessions over the native Node listener and keeps provider credentials out of the SQLite snapshot', async () => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(provider, 'listening');
  const address = provider.address(); if (!address || typeof address === 'string') throw Error();
  provider.on('connection', (ws, request) => {
    ws.binaryType = 'arraybuffer';
    const respond = scriptedBailian(request.headers.authorization, frame => ws.send(frame));
    ws.on('message', (data, binary) => respond(binary && data instanceof ArrayBuffer ? data : data.toString()));
  });
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const app = createNodeApp(store, { CLINMESH_VISITOR_PASSCODE: 'synthetic-example', loadSigningSecret: () => store.visitorSigningSecret() }, { BAILIAN_TOKEN: hostKey }, undefined,
    (url, headers, signal) => { expect(url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference'); return connectNodeVoice(`ws://127.0.0.1:${address.port}`, headers, signal); });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: { server: new WebSocketServer({ noServer: true }) } });
  try {
    await once(server, 'listening'); const bound = server.address(); if (!bound || typeof bound === 'string') throw Error();
    const id = await exercise(`http://127.0.0.1:${bound.port}`);
    const snapshot = JSON.stringify(await store.exportLogicalSnapshot(id));
    expect(snapshot).not.toContain(visitorKey); expect(snapshot).not.toContain(hostKey);
    expect(snapshot).not.toContain('A teaching question.');
  } finally { server.close(); provider.close(); await store.close(); }
}, 30000);

it('runs the same binary speech, BYOK and failure contracts through the workerd Workspace DO', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, main: './src/server/testing/voice-worker.ts', vars: { CLINMESH_VISITOR_PASSCODE: 'synthetic-example', BAILIAN_TOKEN: hostKey } } }] });
  try {
    const { url } = await server.listen();
    const id = await exercise(url.origin);
    const storage = await server.getWorker().getDurableObjectStorage('WORKSPACE_DO', { name: id });
    expect(await storage.exec('SELECT count(*) AS turns FROM consultation_turns')).toEqual([{ turns: 1 }]);
  } finally { await server.close(); }
}, 30000);
