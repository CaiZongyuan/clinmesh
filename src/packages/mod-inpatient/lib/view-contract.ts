import { z } from 'zod';
import { angiography, notice } from './surgery-facts';
import { commonWardView } from './views';
import { id } from './ward';

const object = z.record(z.string(), z.json());
const supply = z.object({ itemId: id, lotId: id, lotNumber: z.string(), reservationId: id, planned: z.int(), actual: z.int(), uses: z.array(z.object({ id, original: z.int(), quantity: z.int(), corrections: z.array(z.object({ quantity: z.int(), reason: z.string() })) })) });
const surgery = z.object({ id, status: z.string(), plan: notice, report: angiography.extend({ id, acknowledged: z.boolean() }).nullable(),
  stages: z.array(z.object({ id, procedureId: id, kind: z.string(), stage: z.string(), parentExecutionId: id.nullable(), executionId: id.nullable(), supplies: z.array(supply), medications: z.array(id) })),
  postoperative: z.array(z.object({ kind: z.string(), code: z.string(), codeSystem: z.string() })), preparations: z.array(z.object({ kind: z.string(), signedBy: z.string(), at: z.iso.datetime(), document: object })) });
export const wardViewSchema = commonWardView.extend({ surgeries: z.array(surgery), chart: z.object({ state: z.string(), revision: z.int(), revisions: z.array(z.object({ revision: z.int(), id, fields: z.object({ summary: z.string(), disposition: z.string(), followUp: z.string() }), submittedBy: z.string() })), review: object.nullable(), archive: object.nullable() }) });
export type WardView = z.infer<typeof wardViewSchema>;
