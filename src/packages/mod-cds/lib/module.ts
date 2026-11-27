import { v7 } from 'uuid';
import { z } from 'zod';
import { editEncounter } from '../../patient-visit';
import { checkVersion, type ClinMeshModule, type OperationCatalog } from '../../platform';
import { authorizedFacts, bedsideFields } from './facts';
import { guidelines, guidelinesSchema, orderSets, orderSetsSchema } from './knowledge';
import { enforceQuality } from './quality';
import { clinicalScoreResultSchema } from './score-contracts';

export const scoreViewSchema = z.object({ scores: z.array(clinicalScoreResultSchema), revision: z.int(), bedside: bedsideFields, effectiveStSegmentDeviation: z.boolean().nullable(), stSource: z.string().nullable() });
const base = '/api/his/encounters/:id/cds';
const read = { access: { capabilities: ['assess', 'sign'] }, assistantRead: 'encounter' as const };
export const cdsModule: ClinMeshModule<OperationCatalog> = { id: 'mod-cds', kind: 'clinical', version: '1', clinicalQuality: enforceQuality,
  workbenchTabs: [{ id: 'cds', label: { en: 'Decision support', zh: '决策支持' }, readOperation: 'cds.scores' }],
  registerOperations(catalog) {
    catalog.query({ ...read, name: 'cds.scores', path: `${base}/scores` }, scoreViewSchema, context => {
      const data = authorizedFacts(context);
      const effective = data.facts.stSegmentDeviation;
      return { scores: data.scores, revision: data.assessment?.revision ?? 0, bedside: data.bedside, effectiveStSegmentDeviation: effective?.value ?? null, stSource: effective?.source?.reference ?? null };
    });
    catalog.query({ ...read, name: 'cds.guidelines', path: `${base}/guidelines` }, guidelinesSchema, context => guidelines(authorizedFacts(context)));
    catalog.query({ ...read, name: 'cds.order-sets', path: `${base}/order-sets` }, orderSetsSchema, context => orderSets(context, authorizedFacts(context)));
    catalog.command({ name: 'cds.risk-assessment', method: 'POST', path: `${base}/risk-assessment`, access: { capabilities: ['sign'], visitorOnly: true } },
      { expectedRevision: z.int().nonnegative(), fields: bedsideFields }, z.object({ version: z.int(), revision: z.int(), assessmentId: z.uuidv7() }), (context, input) => {
        const version = editEncounter(context);
        const previous = context.tx.list(context.at, 'clinical_risk_assessments', { encounter_id: context.targetId }).sort((first, second) => second.revision - first.revision)[0];
        checkVersion(previous?.revision ?? 0, input.expectedRevision);
        const revision = input.expectedRevision + 1;
        const assessmentId = v7();
        context.tx.insert(context.at, 'clinical_risk_assessments', { id: assessmentId, encounter_id: context.targetId, revision, previous_revision_id: previous?.id ?? null, fields: input.fields, signed_by: context.actor.role.id, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
        return { version, revision, assessmentId };
      });
  },
};
