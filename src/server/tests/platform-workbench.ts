import { chromium } from 'playwright-core';
import { expect } from 'vitest';
import { z } from 'zod';
import { teachingGate } from '../../../scripts/testing/node-workspace';
import { encounterViewSchema, workspaceSchema } from '../../packages/clinical-core';
import { visitorKey } from '../testing/voice-provider';

export async function workbenchJourney(origin: string) {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const page = await browser.newPage({ permissions: ['microphone'], viewport: { width: 1440, height: 1000 } });
    const failedActions: string[] = [];
    page.on('websocket', socket => socket.on('framesent', frame => { if (String(frame.payload).includes('"ok":false')) failedActions.push(String(frame.payload)); }));
    page.setDefaultTimeout(12000);
    await page.addInitScript(token => {
      localStorage.setItem('clinmesh.providers.v1', JSON.stringify({ mock: true }));
      localStorage.setItem('clinmesh.voice.v1', JSON.stringify({ engine: 'bailian', token }));
      Object.defineProperty(window, 'SpeechRecognition', { value: class {
        onstart?: () => void; onend?: () => void; onresult?: (value: unknown) => void;
        start() { this.onstart?.(); }
        stop() { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Private teaching dictation' } }] }); this.onend?.(); }
        abort() { this.onend?.(); }
      } });
    }, visitorKey);
    const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
    await page.goto(origin);
    await page.getByLabel('Visitor passcode').fill(teachingGate.CLINMESH_VISITOR_PASSCODE);
    await button('Enter workspace').click();
    await button('Start · Avery Reed').click();
    await button('Role · Intake coordinator').click();
    await page.getByRole('menuitem', { name: 'Family clinician' }).click();
    await button(/Clinician Assistant · Ready/).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByRole('switch', { name: 'Ambient Mode' }).click();
    const cookie = (await page.context().cookies(origin)).find(item => item.name === 'cm_visitor')!;
    const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/json' };
    const workspace = workspaceSchema.parse(await (await fetch(`${origin}/api/workspace`, { headers })).json());
    expect(workspace.roleId).toBe('family-clinician');
    const [{ id }] = z.tuple([z.object({ id: z.uuidv7() })]).parse(await (await fetch(`${origin}/api/his/encounters`, { headers })).json());
    const visit = async () => encounterViewSchema.parse(await (await fetch(`${origin}/api/his/encounters/${id}`, { headers })).json());
    const template = (await visit()).template;
    await page.getByRole('tab', { name: 'Clinical record' }).click();
    await page.getByRole('textbox', { name: template[1]!.title.en }).fill('Protected teaching note');
    await page.getByRole('tab', { name: 'Consultation' }).click();
    await button('Start consultation mic').click();
    await expect.poll(async () => (await visit()).turns.some(turn => turn.channel === 'voice' && turn.speaker === 'clinician' && turn.content === 'A teaching question.'), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await visit()).turns.at(-1)?.speaker).toBe('patient');
    await page.getByText('Review the draft', { exact: true }).first().waitFor({ timeout: 25000 });
    await page.getByRole('tab', { name: 'Clinical record' }).click();
    expect(await page.getByRole('textbox', { name: template[0]!.title.en }).inputValue(), failedActions.join('\n')).toBeTruthy();
    expect(await page.getByRole('textbox', { name: template[1]!.title.en }).inputValue()).toBe('Protected teaching note');
    expect((await visit()).recordRevisions).toHaveLength(0);
    for (const field of template.filter(field => field.required)) {
      const edit = page.getByRole('textbox', { name: field.title.en });
      if (!await edit.inputValue()) await edit.fill(`Teaching clinician reviewed ${field.id}`);
    }
    await button('Save record draft').click();
    const sign = button('Sign record');
    expect(await sign.getAttribute('data-agent-confirm')).toBeTruthy();
    const instruction = page.getByRole('textbox', { name: 'Instruction to assistant' });
    await instruction.fill('Sign the record'); await button('Send to assistant').click();
    await button('Deny request').click();
    expect((await visit()).recordRevisions).toHaveLength(0);
    await instruction.fill('Please sign the record'); await button('Send to assistant').click();
    await button('Allow once').click();
    await expect.poll(async () => (await visit()).recordRevisions.length).toBe(1);
    await page.getByRole('tab', { name: 'Consultation' }).click();
    await button('Voice settings').click();
    await page.getByRole('combobox', { name: 'Voice engine' }).click();
    await page.getByRole('option', { name: 'Browser Web Speech' }).click();
    await button('Close voice settings').click();
    const dictate = button('Hold to dictate to assistant');
    await dictate.dispatchEvent('pointerdown', { button: 0, pointerId: 1 });
    await page.getByText('Assistant mic live', { exact: true }).waitFor();
    await dictate.dispatchEvent('pointerup', { button: 0, pointerId: 1 });
    await expect.poll(() => instruction.inputValue()).toBe('Private teaching dictation');
    expect(JSON.stringify((await visit()).turns)).not.toContain('Private teaching dictation');
    return { headers, workspace, id };
  } finally { await browser.close(); }
}
