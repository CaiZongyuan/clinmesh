import { z } from 'zod';
import { assistantObservations, type AssistantObservation } from '../../agent-protocol';
import { visitSchema } from '../../patient-visit';
import { permits, type Actor, type Credential, type OperationCatalog } from '../../platform';
import type { StorePort } from '../../store';

const localized = z.object({ en: z.string() });
const report = z.object({ id: z.uuidv7(), version: z.int().positive(), summary: localized.optional(), sections: z.record(z.string(), z.unknown()).optional() });
const studies = z.object({ orders: z.array(z.object({ reports: z.array(report) })) });
export async function observeEncounter(store: StorePort, catalog: OperationCatalog, actor: Actor, credential: Credential, encounterId: string) {
  const read = (name: string) => catalog.require(name).invoke({ store, credential, targetId: encounterId, body: async () => ({}) });
  const kinds = (['lab', 'imaging', 'pathology'] as const).filter(kind => catalog.entries.some(entry => entry.name === `${kind}.read` && entry.assistantRead === 'encounter' && permits(actor, entry)));
  const [visit, ...views] = await Promise.all([read('encounter.read'), ...kinds.map(kind => read(`${kind}.read`))]);
  const { turns } = visitSchema.pick({ turns: true }).parse(visit);
  const observations: AssistantObservation[] = [];
  for (const [index, turn] of turns.entries()) {
    const question = turns[index - 1];
    if (question?.speaker === 'clinician' && turn.speaker === 'patient') observations.push({ type: 'consultation.final', id: turn.id, ordinal: turn.ordinal, question: question.content.slice(0, 320), answer: turn.content.slice(0, 640) });
  }
  for (const [index, view] of views.entries()) for (const order of studies.parse(view).orders) for (const current of order.reports) {
    const summary = current.summary?.en ?? Object.values(current.sections ?? {}).flatMap(section => { const parsed = localized.safeParse(section); return parsed.success ? [parsed.data.en] : []; }).join(' ');
    observations.push({ type: 'report.signed', kind: kinds[index]!, id: current.id, version: current.version, summary: summary.slice(0, 640) });
  }
  return assistantObservations.parse(observations);
}
