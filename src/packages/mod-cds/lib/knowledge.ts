import { z } from 'zod';
import { knowledgeSchema, type HospitalDataPack } from '../../data-pack';
import { localizedName, type ReadContext } from '../../platform';
import { catalogCoding, sameCoding, type ClinicalFacts } from './facts';
import { activeDrugs, completedPci, drugContraindication, drugDefinitions, incompatible, recentCreatinine, renalRisk } from './quality';

const evidence = z.object({ codeSystem: z.string(), code: z.string(), unit: z.string(), value: z.union([z.number(), z.string()]), observedAt: z.iso.datetime(), source: z.object({ reference: z.string(), versionId: z.string(), label: z.string() }) });
export const guidelinesSchema = z.object({ population: z.enum(['adult', 'pediatric', 'all-only']), topics: knowledgeSchema.shape.guidelineTopics, observations: z.array(evidence), missingInputs: z.array(z.string()) });
export function guidelines(data: ClinicalFacts) {
  const population = typeof data.age !== 'number' || data.age < 0 ? 'all-only' : data.age < 18 ? 'pediatric' : 'adult';
  const topics = data.knowledge.guidelineTopics.filter(topic => topic.population === 'all' || topic.population === population);
  const missing = topics.flatMap(topic => (topic.evidence ?? []).filter(code => !data.observed.some(item => sameCoding(code, item))).map(code => code.code));
  return guidelinesSchema.parse({ population, topics, observations: data.observed, missingInputs: [...new Set([...missing, ...data.scores.flatMap(score => [...score.missingInputs])])] });
}

const state = z.enum(['unavailable', 'excluded', 'skipped', 'needs-review', 'ready']);
const member = z.object({ kind: z.string(), codeSystem: z.string(), code: z.string(), catalogId: z.uuidv7().nullable(), display: localizedName, status: state, reason: z.string() });
export const orderSetsSchema = z.array(z.object({ id: z.string(), version: z.string(), name: localizedName, members: z.array(member) }));
type Template = NonNullable<HospitalDataPack['knowledge']>['orderSetTemplates'][number];
export function orderSets(context: ReadContext, data: ClinicalFacts) {
  const { reader, actor } = context;
  const active = activeDrugs(reader, actor.at, data);
  const drugs = drugDefinitions(data);
  const installed = context.availableModules ?? actor.enabledModules;
  const compatible = (template: Template) => template.scope === data.encounter.encounter_class || (template.scope === 'postop' && data.encounter.encounter_class === 'inpatient' && completedPci(reader, actor.at, data));
  return data.knowledge.orderSetTemplates.filter(compatible).filter(template => !template.triggerDiagnoses.length || template.triggerDiagnoses.some(code => data.diagnoses.some(diagnosis => sameCoding(code, diagnosis)))).map(template => ({
    id: template.id, version: data.pack.pack_version, name: template.name, members: template.members.map(entry => {
      const item = data.catalog.find(row => row.kind === entry.kind && sameCoding(catalogCoding(row), entry));
      const serviceKind = item?.definition.kind;
      const required = entry.kind === 'medications' ? (data.encounter.encounter_class === 'inpatient' ? 'mod-inpatient' : 'mod-pharmacy') : (entry.kind !== 'services' || serviceKind === 'nursing' || item?.definition.requiresProcedure) ? 'mod-inpatient' : serviceKind === 'imaging' ? 'mod-imaging' : serviceKind === 'pathology' ? 'mod-pathology' : 'mod-lab';
      const value = { ...entry, catalogId: item?.id ?? null, display: localizedName.parse(item?.definition.display ?? { en: entry.code, zh: entry.code }) };
      const result = (status: z.infer<typeof state>, reason: string) => ({ ...value, status, reason });
      if (!item || item.amount_minor === null || !installed.includes(required)) return result('unavailable', 'catalog-unavailable');
      if (template.hardContraindications.some(code => data.diagnoses.some(diagnosis => sameCoding(code, diagnosis)))) return result('excluded', 'diagnosis-contraindication');
      const drug = drugs.find(drug => drug.id === item.id);
      if (drug) {
        const contraindication = drugContraindication(data, drug);
        if (contraindication) return result('excluded', contraindication);
        const { minimumHeartRate, minimumSystolic } = drug.safety;
        if ((minimumHeartRate && data.facts.heartRateBpm && data.facts.heartRateBpm.value < minimumHeartRate) || (minimumSystolic && data.facts.systolicBpMmHg && data.facts.systolicBpMmHg.value < minimumSystolic)) return result('excluded', 'vital-sign-contraindication');
        if (active.some(other => incompatible(data, drug, other))) return result('skipped', 'already-active-medication');
        if ((minimumHeartRate && !data.facts.heartRateBpm) || (minimumSystolic && !data.facts.systolicBpMmHg) || (renalRisk(drug) && !recentCreatinine(data)) || data.caseView.priorHistory.allergies.status === 'not-asked') return result('needs-review', 'pending-verification');
      } else if (data.orders.some(order => order.catalog_item_id === item.id && ['issued', 'accepted', 'in-progress', 'signed', 'verified'].includes(order.status))) return result('skipped', 'in-flight-order');
      if (template.requiredEvidence.some(code => !data.reports.some(report => sameCoding(code, report.service)))) return result('needs-review', 'missing-required-evidence');
      return result('ready', 'available');
    }),
  }));
}
