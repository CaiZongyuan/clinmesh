import { expect, it } from 'vitest';
import general from '../../../../data/packs/global-general/pack.json';
import cardiology from '../../../../data/packs/cn-cardiology/pack.json';
import { parseHospitalDataPack } from '../../data-pack';
import { checkPrescription, type PharmacyContext, type PrescriptionLine } from '../index';

const pack = parseHospitalDataPack(general);
const catalog = pack.catalog.medications;
const rules = pack.knowledge!.pharmacy!;
const context: PharmacyContext = { rules, allergies: ['penicillin'], diagnoses: [{ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'j18.9' }], activeMedications: [] };
const line = (code: string, dose: number): PrescriptionLine => ({ codeSystem: 'urn:clinmesh:general:drug', code, dose, routeCode: 'PO', timesPerDay: 2, days: 5, quantity: 10 });

it('blocks a confirmed CAP allergy and accepts the pack’s alternative in the shared decision', () => {
  expect(checkPrescription(catalog, [line('amoxicillin', 500)], context)).toContain('MEDICATION_ALLERGY_CONFLICT');
  expect(checkPrescription(catalog, [line('doxycycline', 100)], context)).toEqual([]);
});

it.each([
  ['PRESCRIPTION_SINGLE_DOSE_LIMIT', { dose: 101 }], ['PRESCRIPTION_DAILY_DOSE_LIMIT', { timesPerDay: 3 }],
  ['PRESCRIPTION_DAILY_DOSE_LIMIT', { timesPerDay: 0 }], ['PRESCRIPTION_COURSE_LIMIT', { days: 31 }],
  ['PRESCRIPTION_COURSE_LIMIT', { days: 0 }], ['PRESCRIPTION_QUANTITY_LIMIT', { quantity: 11 }],
  ['PRESCRIPTION_QUANTITY_LIMIT', { quantity: 0 }], ['PRESCRIPTION_QUANTITY_LIMIT', { quantity: 0.5 }],
  ['PRESCRIPTION_ROUTE_NOT_ALLOWED', { routeCode: 'IV' }], ['PRESCRIPTION_ROUTE_NOT_ALLOWED', { routeCode: 'invalid' }],
] as const)('rejects %s for %o', (code, change) => {
  expect(checkPrescription(catalog, [{ ...line('doxycycline', 100), ...change }], context)).toContain(code);
});

it('checks the dispense ceiling, diagnosis system, number of lines and ingredient across sources', () => {
  const order = line('doxycycline', 100);
  expect(checkPrescription(catalog, [order], { ...context, rules: null })).toEqual(['PHARMACY_RULES_UNAVAILABLE']);
  const external = { ...order, codeSystem: 'urn:clinmesh:general:community-drug', code: 'doxy-100' };
  expect(checkPrescription(catalog, [], context)).toContain('PRESCRIPTION_LINE_COUNT');
  expect(checkPrescription(catalog, Array(9).fill(order), context)).toContain('PRESCRIPTION_LINE_COUNT');
  expect(checkPrescription(catalog, [order, external], context)).toEqual(['PRESCRIPTION_MIXED_CATALOG_SOURCES', 'PRESCRIPTION_DUPLICATE_MEDICATION']);
  expect(checkPrescription(catalog, [order], { ...context, activeMedications: [order] })).toEqual(['PRESCRIPTION_DUPLICATE_MEDICATION']);
  expect(checkPrescription(catalog, [order], { ...context, diagnoses: [{ codeSystem: 'urn:unrelated', code: 'J18' }] })).toEqual(['PRESCRIPTION_INDICATION_MISMATCH']);
  const highLimit = catalog.map(item => ({ ...item, safety: { ...item.safety, maxDailyDose: 200000 } }));
  expect(checkPrescription(highLimit, [{ ...order, quantity: 1001 }], context)).toEqual(['PRESCRIPTION_QUANTITY_LIMIT']);
});

it.each([['perindopril', 'valsartan'], ['sacubitril-valsartan', 'perindopril'], ['valsartan', 'sacubitril-valsartan'],
  ['clopidogrel', 'ticagrelor'], ['atorvastatin', 'rosuvastatin']])('applies pack class incompatibilities for %s and %s', (first, second) => {
  const cardio = parseHospitalDataPack(cardiology);
  const items = cardio.catalog.medications;
  const orders = [first, second].map(code => ({ ...line(code, 1), codeSystem: 'urn:clinmesh:cv:drug', quantity: 1 }));
  const facts = { ...context, rules: cardio.knowledge!.pharmacy!, diagnoses: ['I50', 'I21'].map(code => ({ ...context.diagnoses[0]!, code })) };
  expect(checkPrescription(items, orders, facts)).toContain('PRESCRIPTION_CLASS_CONFLICT');
  expect(checkPrescription(items, [orders[0]!], { ...facts, activeMedications: [orders[1]!] })).toContain('PRESCRIPTION_CLASS_CONFLICT');
});
