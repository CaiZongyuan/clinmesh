import { expect, it } from 'vitest';
import teaching from '../../../../data/packs/diagnostic-teaching/pack.json';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { parseHospitalDataPack } from '../../data-pack';
import { accountSchema } from '../../mod-billing';
import { openAiText, userProvider, withProvider } from '../../../../scripts/testing/agent-provider';

const pack = () => structuredClone(parseHospitalDataPack(teaching));
it('freezes one quoted charge, publishes a signed CT, gates review, and requires review of the corrected version', async () => {
  const data = pack();
  data.cases.push({ ...structuredClone(data.cases[0]!), caseId: 'other', demographics: { ...data.cases[0]!.demographics, name: 'Other case', identifiers: [{ issuer: 'Teaching Clinic', value: 'SIM-02' }] } });
  const host = await studyWorkspace(data);
  try {
    const imaging = host.study('imaging');
    const item = (await imaging.view()).services[0]!.quote;
    await expect(host.write(`${host.base}/imaging/issue`, 1, { item: { ...item, unitPriceMinor: 1 } })).rejects.toThrow('CATALOG_CONFLICT');
    const order = await imaging.issue('Noncontrast chest CT');
    await expect(imaging.issue('Noncontrast chest CT')).rejects.toThrow('ACTIVE_ORDER_EXISTS');
    await expect(imaging.advance(order, 'start', 1)).rejects.toThrow('INVALID_ORDER_STATE');
    const first = await imaging.report(order);
    expect(first).toMatchObject({ version: 1, sections: { kind: 'imaging', impression: { en: 'Postoperative scar without a focal mass.' } }, requireFirstFrame: true, frameCount: 2, acknowledged: null });
    const frames = `${host.base}/imaging/reports/${first.id}/frames`;
    expect(await host.read(frames)).toEqual({ reportId: first.id, frames: ['phantom-a.png', 'phantom-b.png'] });
    const other = await host.startCase((await host.workspace()).cases[1]!.id);
    expect((await host.request(frames.replace(host.encounterId, other))).status).toBe(404);
    expect((await host.request(frames.replace('/imaging/', '/pathology/'))).status).toBe(404);
    for (const response of [await host.workspace(), await host.encounter(), await imaging.view()]) expect(JSON.stringify(response)).not.toContain('phantom-');
    await expect(imaging.review(first.id, 'acknowledge', 4, 1, 'text')).rejects.toThrow('REPORT_REVIEW_MODE_INVALID');
    await imaging.review(first.id, 'acknowledge', 4, 1, 'first-frame-rendered');
    await host.role('cashier');
    expect((await host.request(frames)).status).toBe(403);
    expect(accountSchema.parse(await host.read(`${host.base}/billing`)).charges).toMatchObject([{ orderId: order, amountMinor: 7500, quantity: 1, released: true }]);
    await host.role('coordinator');
    await imaging.review(first.id, 'amend', 5, 1);
    await host.role('clinician');
    const revised = (await imaging.view()).orders[0]!.reports[1]!;
    expect(revised).toMatchObject({ previousId: first.id, version: 2, acknowledged: null, sections: { findings: { en: expect.stringContaining('3 mm') } } });
    await expect(imaging.review(first.id, 'acknowledge', 6, 1, 'first-frame-rendered')).rejects.toThrow('REPORT_SUPERSEDED');
    const gate = async () => (await host.encounter()).completion.checks.find(check => check.id === 'imaging-acknowledgement')?.passed;
    expect(await gate()).toBe(false);
    await imaging.review(revised.id, 'acknowledge', 6, 2, 'frames-unavailable');
    expect(await gate()).toBe(true);
    expect(await host.store.read(reader => reader.list(host.at, 'audit_events', { target_id: revised.id, operation: 'imaging.review-mode' }).map(row => row.outcome))).toEqual(['frames-unavailable']);
    expect((await imaging.view()).orders[0]!.reports[0]).toMatchObject({ acknowledged: { role: 'clinician' } });
    const plain = await imaging.report(await imaging.issue('Chest radiograph'));
    expect(plain).toMatchObject({ frameCount: 0, requireFirstFrame: false });
    await imaging.review(plain.id, 'acknowledge', 4, 1, 'text');
  } finally { await host.close(); }
});

it('keeps direct text review configurable for illustrated studies and enforces prepaid release', async () => {
  const data = pack();
  data.manifest.policies.outpatientInvestigationBillingPolicy = 'prepaid';
  data.manifest.policies.requireRenderedReportFrame = false;
  const host = await studyWorkspace(data);
  try {
    const study = host.study('imaging');
    const id = await study.issue('Noncontrast chest CT');
    await expect(study.advance(id, 'accept', 1)).rejects.toThrow('PAYMENT_REQUIRED');
    await host.role('cashier');
    const account = accountSchema.parse(await host.read(`${host.base}/billing`));
    const path = `${host.base}/billing`;
    const preview = await host.write(`${path}/payment.preview`, account.version, { chargeIds: [account.charges[0]!.id] });
    await host.write(`${path}/payment.confirm`, account.version, { commitToken: preview.commitToken });
    await host.role('clinician');
    const first = await study.report(id);
    expect(first).toMatchObject({ frameCount: 2, requireFirstFrame: false });
    await study.review(first.id, 'acknowledge', 4, 1, 'text');
  } finally { await host.close(); }
});

it('keeps asset references and report conclusions out of the real Patient Agent provider context', async () => {
  let prompt = '';
  await withProvider(52008, (_request, response, payload) => { prompt = payload; openAiText(response, 'My scar itches.'); }, async baseUrl => {
    const host = await studyWorkspace(pack(), { CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl });
    try {
      const study = host.study('imaging');
      await study.report(await study.issue('Noncontrast chest CT'));
      const result = await host.write(`${host.base}/consultation/turns`, (await host.encounter()).version, { content: 'How do you feel?', channel: 'text' }, undefined, 'POST', userProvider(baseUrl));
      await (await host.request(`/api/agents/sessions/${result.sessionId}/events`, { headers: userProvider(baseUrl) })).text();
      expect(prompt).toContain('The scar sometimes itches');
      expect(prompt).not.toMatch(/phantom-|\.png|noncontrast chest|focal mass|reviewPoints/i);
    } finally { await host.close(); }
  });
});
