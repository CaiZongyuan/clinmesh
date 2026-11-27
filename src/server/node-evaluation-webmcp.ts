import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import type { EvaluationGateway, OperationInput } from '../packages/agent-runtime';
import { CoreError } from '../packages/platform';

export async function openWebMcpEnvironment(gateway: EvaluationGateway) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-blink-features=WebMCP'] }).catch(() => { throw new CoreError(503, 'WEBMCP_BROWSER_UNAVAILABLE'); });
  try {
    const page = await browser.newPage();
    const origin = 'https://evaluation.invalid';
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !/^\/(?:evaluation\.html|assets\/[\w.-]+\.js)$/.test(url.pathname)) return route.abort();
      await route.fulfill({ body: await readFile(join('dist/client', url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html' : 'text/javascript' });
    });
    await page.addInitScript(operations => { window.evaluationOperations = operations; }, gateway.operations.map(({ id, risk }) => ({ id, formal: risk === 'high-risk-write' })));
    await page.exposeFunction('submitEvaluationOperation', async (id: string, raw: unknown) => {
      try { return { data: await gateway.invoke(id, z.record(z.string(), z.json()).parse(raw)) }; }
      catch (error) { return { error: error instanceof CoreError ? error.code : 'INVALID_INPUT' }; }
    });
    const client = await page.context().newCDPSession(page);
    let registered: { frameId: string } | undefined;
    client.on('WebMCP.toolsAdded', ({ tools }) => { registered = tools.find(tool => tool.name === 'act') ?? registered; });
    await client.send('WebMCP.enable');
    await page.goto(`${origin}/evaluation.html`);
    await page.locator('#receipt').waitFor({ state: 'attached' });
    if (!registered) throw new CoreError(503, 'WEBMCP_REGISTRATION_UNAVAILABLE');
    const { frameId } = registered;
    let sequence = 0, pending: Promise<unknown> = Promise.resolve();
    async function press(id: string, fields: OperationInput) {
      const input = { steps: [{ ref: 'Operation input', action: 'setValue', args: [JSON.stringify(fields)] }, { ref: id, action: 'press' }] };
      await client.send('WebMCP.invokeTool', { frameId, toolName: 'act', input: JSON.parse(JSON.stringify(input)) });
      await page.locator(`#receipt[data-sequence="${++sequence}"]`).waitFor({ state: 'attached', timeout: 8000 });
      const receipt = z.union([z.object({ data: z.json() }), z.object({ error: z.string() })]).parse(JSON.parse(await page.locator('#receipt').innerText()));
      if ('error' in receipt) throw new CoreError(409, receipt.error);
      return receipt.data;
    }
    return { invoke(id: string, input: OperationInput) { const result = pending.then(() => press(id, input)); pending = result.catch(() => {}); return result; }, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error instanceof CoreError ? error : new CoreError(503, 'WEBMCP_REGISTRATION_UNAVAILABLE'); }
}
