import { z } from 'zod';
import { medicationRouteSchema } from '../../store';

const text = z.string().trim().min(1);
const texts = z.array(text);
const bilingual = z.strictObject({ en: text, zh: text });
export const coding = z.strictObject({ codeSystem: z.url(), code: text });
const concept = coding.extend({ display: bilingual });
const money = z.int().nonnegative();
const positive = z.number().positive();
const sex = z.enum(['female', 'male', 'other', 'unknown']);
const encounterClass = z.enum(['outpatient', 'inpatient']);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const locale = text.refine(value => {
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
});
const timezone = text.refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
const age = z.int().nonnegative();
const visibility = z.strictObject({
  departmentId: text.optional(), encounterClass: encounterClass.optional(), sex: sex.optional(),
  minAge: age.optional(), maxAge: age.optional(),
}).refine(rule => rule.minAge === undefined || rule.maxAge === undefined || rule.minAge <= rule.maxAge);

export const manifest = z.strictObject({
  packId: text, version: text, schemaVersion: z.literal(1), name: bilingual, description: bilingual,
  defaultLocale: locale, supportedLocales: z.array(locale).min(1), timezone,
  currency: z.strictObject({ code: z.string().regex(/^[A-Z]{3}$/), symbol: text, minorUnitExponent: z.int().min(0).max(9) }),
  enabledModules: texts,
  policies: z.strictObject({
    outpatientInvestigationBillingPolicy: z.enum(['prepaid', 'postpaid', 'free']),
    requireSignedNoteBeforeOrder: z.boolean(), requireDiagnosisBeforeOrder: z.boolean(), completionGates: texts,
    shiftSchedule: z.array(z.strictObject({ id: text, start: timeOfDay, end: timeOfDay })),
  }),
  clinicalRecordTemplate: z.array(z.strictObject({ id: text, title: bilingual, required: z.boolean(), showWhen: visibility.optional() })).min(1),
});

const named = z.strictObject({ id: text, name: bilingual });
export const organization = z.strictObject({
  capabilities: texts, departments: z.array(named).min(1),
  wards: z.array(named.extend({ departmentId: text })), beds: z.array(named.extend({ wardId: text })),
  practitionerRoles: z.array(named.extend({ capabilities: texts })).min(1),
  practitioners: z.array(named.extend({ departmentId: text, roleId: text })),
});

const bounds = z.strictObject({ low: z.number().optional(), high: z.number().optional() }).refine(
  range => (range.low !== undefined || range.high !== undefined) && (range.low === undefined || range.high === undefined || range.low <= range.high),
);
const analyte = concept.extend({ unit: text, referenceRange: bounds.optional(), critical: bounds.optional() });
export const medication = concept.extend({
  source: z.enum(['internal', 'external']).default('internal'), ingredient: coding.optional(),
  routeCodes: z.strictObject({ default: text, allowed: z.array(medicationRouteSchema).min(1) }), dosageUnits: texts.min(1),
  inpatientDoseBasis: z.strictObject({ amount: positive, unit: text }),
  safety: z.strictObject({
    classCodes: texts.min(1), allergyGroupCodes: texts, indicationPrefixes: texts,
    maxSingleDose: positive, maxDailyDose: positive, contraindicatedEgfrBelow: positive.optional(),
  }),
  packageInsertSummary: bilingual, unitPriceMinor: money, insuranceTier: text.optional(),
});
const service = concept.extend({
  kind: z.enum(['lab', 'examination', 'imaging', 'pathology', 'nursing', 'registration']),
  unitPriceMinor: money, unit: text, analytes: z.array(analyte),
  turnaroundMinutes: z.int().min(1).max(10080).optional(), requiresProcedure: z.boolean().optional(),
  specimenContainer: z.strictObject({ specimen: text, container: text }).optional(),
});
export const catalog = z.strictObject({
  diagnoses: z.array(concept.extend({ aliases: texts.optional() })), medications: z.array(medication), services: z.array(service),
  procedures: z.array(concept.extend({
    unitPriceMinor: money, unit: text, defaultAnesthesia: text, defaultLocation: text,
    defaultPreopOrderPolicy: z.enum(['continue-active', 'stop-on-completion']), preopServices: z.array(coding),
  })),
  materials: z.array(concept.extend({ unitPriceMinor: money, unit: text, diameterMm: positive.optional(), lengthMm: positive.optional() })),
});

export const pharmacyRules = z.strictObject({ indicationCodeSystem: z.url(), classConflicts: z.array(z.tuple([text, text])) });
const stockLot = z.strictObject({ codeSystem: z.url(), medicationCodes: texts.min(1), lotNumber: text, expiryDate: z.iso.date(), quantity: z.int().positive(), unit: text });
export const pharmacyKnowledge = pharmacyRules.extend({ openingStock: z.array(stockLot) });
const member = coding.extend({ kind: z.enum(['medications', 'services', 'procedures', 'materials']) });
export const knowledge = z.strictObject({
  pharmacy: pharmacyKnowledge.optional(),
  guidelineTopics: z.array(z.strictObject({
    id: text, source: z.httpUrl(), version: text, physicalPage: z.int().positive(), verbatim: text, qualifiers: texts,
    population: z.enum(['adult', 'pediatric', 'all']),
  })),
  orderSetTemplates: z.array(named.extend({
    scope: z.enum(['outpatient', 'inpatient', 'postop']), triggerDiagnoses: z.array(coding), members: z.array(member).min(1),
    hardContraindications: z.array(coding), requiredEvidence: z.array(coding),
  })),
  regionalRules: z.record(text, z.json()).optional(),
});

const allergy = z.strictObject({ groupCode: text, severity: z.enum(['mild', 'moderate', 'severe']), reaction: bilingual });
const observation = z.strictObject({ analyte: coding, value: z.union([z.number(), text]) });
export const priorHistory = z.strictObject({
  diagnoses: z.array(coding), medications: z.array(coding),
  observations: z.array(observation.extend({ observedAt: z.iso.datetime(), service: coding, unit: text })).default([]),
  allergies: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('not-asked') }), z.strictObject({ status: z.literal('none-known') }),
    z.strictObject({ status: z.literal('confirmed'), items: z.array(allergy).min(1) }),
  ]),
});
export const demographics = z.strictObject({ name: text, sex, birthDate: z.iso.date(), identifiers: z.array(z.strictObject({ issuer: text, value: text })).min(1) });
export const triageVitals = z.strictObject({ temperatureC: positive, heartRateBpm: positive, respiratoryRate: positive, systolicMmHg: positive, diastolicMmHg: positive, spo2Percent: positive.max(100) });
export const persona = z.strictObject({
  character: bilingual, healthLiteracy: bilingual, speechStyle: bilingual, openingStatement: bilingual,
  symptoms: z.array(bilingual).min(1), medicationMemory: bilingual, boundaries: z.array(bilingual).min(1),
});

const asset = text.refine(value => {
  if (value.startsWith('https://')) return z.httpUrl().safeParse(value).success;
  return /^(?:[\w-]+\/)*[\w.-]+\.(?:webp|png|jpe?g)$/i.test(value) && !value.includes('..');
});
const authoredFindings = z.strictObject({ service: coding, summary: bilingual,
  observations: z.array(observation.extend({ unit: text.optional(), interpretation: z.enum(['normal', 'high', 'low', 'abnormal']).optional() })),
});
const result = authoredFindings.extend({
  stage: z.enum(['initial', 'inpatient', 'repeat', 'follow-up']), revision: z.int().positive(),
  amendmentReason: bilingual.optional(), images: z.array(asset).optional(),
});
export const truth = z.strictObject({
  primaryDiagnosis: coding, secondaryDiagnoses: z.array(coding), hiddenHistory: z.array(bilingual), results: z.array(result),
  normalBaselines: z.array(authoredFindings).optional(),
  reviewPoints: z.array(bilingual).min(1), expectedMedications: z.array(coding).optional(),
  noMedication: z.literal(true).optional(), expectedProcedures: z.array(coding).optional(), expectedMaterials: z.array(coding).optional(),
});
const clinicalCase = z.strictObject({
  caseId: text, version: text, encounterClass, tags: texts, demographics, priorHistory, triageVitals, patientPersona: persona, caseTruth: truth,
});
export const packSchema = z.strictObject({ manifest, organization, catalog, knowledge: knowledge.optional(), cases: z.array(clinicalCase).min(1) });
export type HospitalDataPack = z.infer<typeof packSchema>;
export type Coding = z.infer<typeof coding>;
export type CatalogKind = keyof HospitalDataPack['catalog'];
