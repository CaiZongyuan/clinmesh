import { z } from 'zod';
import { medicationSchema, pharmacyRulesSchema, type Coding } from '../../data-pack';

export type Medication = z.infer<typeof medicationSchema>;
export const prescriptionLineSchema = z.strictObject({ codeSystem: z.url(), code: z.string().min(1), dose: z.number(),
  routeCode: z.string(), timesPerDay: z.number(), days: z.number(), quantity: z.number() });
export type PrescriptionLine = z.infer<typeof prescriptionLineSchema>;
const coding = prescriptionLineSchema.pick({ codeSystem: true, code: true });
export const pharmacyContextSchema = z.object({ rules: pharmacyRulesSchema.strip().nullable(), allergies: z.array(z.string()), diagnoses: z.array(coding), activeMedications: z.array(coding) });
export type PharmacyContext = z.infer<typeof pharmacyContextSchema>;

export const sameCode = (first: Coding, second: Coding) => first.code === second.code && first.codeSystem === second.codeSystem;

export function checkPrescription(catalog: readonly Medication[], lines: readonly PrescriptionLine[], context: PharmacyContext): string[] {
  const rules = context.rules;
  if (!rules) return ['PHARMACY_RULES_UNAVAILABLE'];
  const issues = new Set<string>();
  const sources = new Set<string>();
  const active = catalog.filter(item => context.activeMedications.some(coding => sameCode(coding, item)));
  if (!lines.length || lines.length > 8) issues.add('PRESCRIPTION_LINE_COUNT');
  for (const line of lines) {
    const item = catalog.find(candidate => sameCode(candidate, line));
    if (!item) { issues.add('MEDICATION_NOT_IN_CATALOG'); continue; }
    sources.add(item.source);
    const { safety, inpatientDoseBasis } = item;
    if (safety.allergyGroupCodes.some(group => context.allergies.includes(group))) issues.add('MEDICATION_ALLERGY_CONFLICT');
    if (!item.routeCodes.allowed.some(code => code === line.routeCode)) issues.add('PRESCRIPTION_ROUTE_NOT_ALLOWED');
    if (active.some(other => sameCode(item.ingredient ?? item, other.ingredient ?? other))) issues.add('PRESCRIPTION_DUPLICATE_MEDICATION');
    for (const [first, second] of rules.classConflicts) {
      if (active.some(other => (safety.classCodes.includes(first) && other.safety.classCodes.includes(second)) ||
        (safety.classCodes.includes(second) && other.safety.classCodes.includes(first)))) issues.add('PRESCRIPTION_CLASS_CONFLICT');
    }
    active.push(item);
    if (!(line.dose > 0 && line.dose <= safety.maxSingleDose)) issues.add('PRESCRIPTION_SINGLE_DOSE_LIMIT');
    if (!Number.isSafeInteger(line.timesPerDay) || line.timesPerDay < 1 || line.dose * line.timesPerDay > safety.maxDailyDose) issues.add('PRESCRIPTION_DAILY_DOSE_LIMIT');
    if (!Number.isInteger(line.days) || line.days < 1 || line.days > 30) issues.add('PRESCRIPTION_COURSE_LIMIT');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000 || line.quantity * inpatientDoseBasis.amount > safety.maxDailyDose * line.days) issues.add('PRESCRIPTION_QUANTITY_LIMIT');
    if (safety.indicationPrefixes.length && !context.diagnoses.some(diagnosis => diagnosis.codeSystem === rules.indicationCodeSystem &&
      safety.indicationPrefixes.some(prefix => diagnosis.code.toUpperCase().startsWith(prefix.toUpperCase())))) issues.add('PRESCRIPTION_INDICATION_MISMATCH');
  }
  return [...(sources.size > 1 ? ['PRESCRIPTION_MIXED_CATALOG_SOURCES'] : []), ...issues];
}
