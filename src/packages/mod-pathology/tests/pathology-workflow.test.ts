import { expect, it } from 'vitest';
import teaching from '../../../../data/packs/diagnostic-teaching/pack.json';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { parseHospitalDataPack } from '../../data-pack';

it('links only this case’s visible surgery, publishes pathology, and preserves the prior acknowledgement after amendment', async () => {
  const data = structuredClone(parseHospitalDataPack(teaching));
  const host = await studyWorkspace(data);
  try {
    const study = host.study('pathology');
    const name = 'Surgical pathology consultation';
    for (const id of [undefined, 'foreign-procedure']) await expect(study.issue(name, id)).rejects.toThrow('VISIBLE_SURGERY_REQUIRED');
    expect((await study.view()).orders).toEqual([]);
    const order = await study.issue(name, 'excision-01');
    const first = await study.report(order);
    expect(first).toMatchObject({ sections: { kind: 'pathology', microscopy: { en: 'Lobules of mature adipocytes with thin fibrous septa.' }, diagnosis: { en: 'Lipoma of the chest wall.' } }, frameCount: 1 });
    expect((await study.view()).orders[0]!.priorSurgeryId).toBe('excision-01');
    await expect(host.study('imaging').review(first.id, 'acknowledge', 4, 1, 'frames-unavailable')).rejects.toThrow('STUDY_NOT_FOUND');
    await study.review(first.id, 'acknowledge', 4, 1, 'first-frame-rendered');
    await host.role('coordinator');
    await study.review(first.id, 'amend', 5, 1);
    await host.role('clinician');
    const [old, latest] = (await study.view()).orders[0]!.reports;
    expect(old?.acknowledged?.role).toBe('clinician');
    expect(latest).toMatchObject({ previousId: first.id, version: 2, requireFirstFrame: false, frameCount: 0, acknowledged: null, sections: { diagnosis: { en: 'Lipoma, margin clear.' } } });
    expect((await host.encounter()).completion.checks.find(check => check.id === 'pathology-acknowledgement')?.passed).toBe(false);
    await study.review(latest!.id, 'acknowledge', 6, 2, 'text');
    expect((await host.encounter()).completion.checks.find(check => check.id === 'pathology-acknowledgement')?.passed).toBe(true);
  } finally { await host.close(); }
});

it('uses independently enabled modules and rejects foreign result-to-surgery links at pack compilation', async () => {
  const data = structuredClone(parseHospitalDataPack(teaching));
  data.manifest.enabledModules = ['mod-pathology'];
  const host = await studyWorkspace(data);
  try {
    expect((await host.workspace()).tabs.map(tab => tab.id)).toEqual(['pathology']);
    expect(await host.read(`${host.base}/imaging`)).toEqual({ code: 'MODULE_DISABLED' });
    const study = host.study('pathology');
    await study.report(await study.issue('Surgical pathology consultation', 'excision-01'));
  } finally { await host.close(); }
  data.cases[0]!.priorHistory.surgeries = [];
  expect(() => parseHospitalDataPack(data)).toThrow('results.priorSurgeryId');
});
