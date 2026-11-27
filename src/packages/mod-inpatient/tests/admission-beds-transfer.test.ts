import { expect, it } from 'vitest';
import { z } from 'zod';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { wardClient } from './ward-client';

it('keeps the hospital bed locked to one admission and atomically swaps both assignments', () => withNodeWorkspace(async origin => {
  const ward = await wardClient((path, init) => fetch(origin + path, init));
  const first = await ward.admit('赵德明');
  const second = await ward.admit('周秀兰');
  await ward.role('ward-nurse');
  await ward.send('ward.bed.assign', first, 1, { bed: 'heart-01' });
  await expect(ward.send('ward.bed.assign', second, 1, { bed: 'heart-01' })).rejects.toThrow('BED_OCCUPIED');
  await ward.send('ward.bed.assign', second, 1, { bed: 'heart-02' });
  await expect(ward.send('ward.bed.swap', first, 2, { otherEncounterId: second, otherVersion: 1 })).rejects.toThrow('VERSION_CONFLICT');
  await ward.send('ward.bed.swap', first, 2, { otherEncounterId: second, otherVersion: 2 });
  expect(await ward.get(`/api/his/ward/${first}`)).toMatchObject({ status: 'admitted', bed: 'heart-02', version: 3 });
  expect(await ward.get(`/api/his/ward/${second}`)).toMatchObject({ status: 'admitted', bed: 'heart-01', version: 3 });
}, false, { CLINMESH_PORT: '51961' }), 30_000);

it('redeems one outpatient certificate and enforces sending and receiving ward ownership and transit blockers', () => withNodeWorkspace(async origin => {
  const ward = await wardClient((path, init) => fetch(origin + path, init));
  await ward.role('cardiologist');
  const source = ward.current().cases.find(item => item.encounterClass === 'outpatient')!;
  const { encounterId } = await ward.send('encounter.start', source.id, 0);
  const { certificateId } = await ward.send('ward.certificate.issue', z.string().parse(encounterId), 1, { ward: 'heart-ward', reason: 'Requires admission' });
  await ward.role('registration-desk');
  const key = crypto.randomUUID();
  const redeem = (key: ReturnType<typeof crypto.randomUUID>) => ward.send('ward.certificate.redeem', z.string().parse(certificateId), 0, {}, key);
  const receipt = await redeem(key);
  expect(await redeem(key)).toEqual(receipt);
  await expect(redeem(crypto.randomUUID())).rejects.toThrow('CERTIFICATE_REDEEMED');
  const visit = z.string().parse(receipt.encounterId);
  expect(await ward.get(`/api/his/encounters/${visit}`)).toMatchObject({ encounterClass: 'inpatient', patient: { name: '陈志远' } });
  await ward.role('ward-nurse'); await ward.send('ward.bed.assign', visit, 1, { bed: 'heart-01' });
  await ward.role('cardiologist');
  await ward.send('ward.diagnose', visit, 2, { diagnoses: [{ code: 'I21.4', codeSystem: 'http://hl7.org/fhir/sid/icd-10', primary: true, poa: 'Y', ordinal: 1 }] });
  const items = z.array(z.object({ id: z.string(), code: z.string() })).parse((await ward.get('/api/his/ward')).items);
  const itemId = items.find(item => item.code === 'atorvastatin')!.id;
  const { orderId } = await ward.send('ward.order.sign', visit, 3, { itemId, duration: 'temporary', frequency: 'ONCE', dose: 10, route: 'PO' });
  await ward.send('ward.transfer.request', visit, 4, { ward: 'recovery-ward' });
  await ward.role('ward-nurse'); await expect(ward.send('ward.transfer.handover', visit, 5)).rejects.toThrow('TRANSFER_BLOCKED');
  await ward.role('cardiologist'); await ward.send('ward.order.request-stop', visit, 5, { orderIds: [orderId] });
  await ward.role('ward-nurse'); await ward.send('ward.order.verify-stop', visit, 6, { orderIds: [orderId] });
  await ward.send('ward.transfer.handover', visit, 7);
  await expect(ward.send('ward.transfer.receive', visit, 8, { bed: 'recovery-01' })).rejects.toThrow('WARD_ROLE_REQUIRED');
  await ward.role('recovery-nurse'); await ward.send('ward.transfer.receive', visit, 8, { bed: 'recovery-01' });
  expect(await ward.get(`/api/his/ward/${visit}`)).toMatchObject({ ward: 'recovery-ward', bed: 'recovery-01', transfer: null });
  expect(await ward.get(`/api/his/encounters/${visit}`)).toMatchObject({ responsibleRole: 'recovery-physician' });
}, false, { CLINMESH_PORT: '51961' }), 30_000);
