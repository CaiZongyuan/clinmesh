import { v7 } from 'uuid';
import { z } from 'zod';
import { trimmedInput } from '../../operation-catalog';
import { CoreError, sha256, type CommandContext } from '../../platform';
import type { StoreScope, StoreTx } from '../../store';
import { editEncounter, requireEncounter } from './encounters';

export const turnInput = z.strictObject({ content: trimmedInput(1, 8000), channel: z.enum(['text', 'voice']) });
function append(tx: StoreTx, at: StoreScope, encounterId: string, speaker: 'clinician' | 'patient', input: z.infer<typeof turnInput>, virtualAt: string, recordedAt: string, questionId?: string) {
  const consultation = tx.list(at, 'consultations', { encounter_id: encounterId })[0]!;
  const pending = speaker === 'clinician';
  if (consultation.reply_pending === pending) throw new CoreError(409, pending ? 'CONSULTATION_REPLY_IN_FLIGHT' : 'NO_PENDING_QUESTION');
  const turns = tx.list(at, 'consultation_turns', { consultation_id: consultation.id });
  if (questionId && !turns.some(turn => turn.ordinal === turns.length && turn.id === questionId && turn.speaker === 'clinician')) throw new CoreError(409, 'QUESTION_CHANGED');
  tx.update(at, 'consultations', consultation.id, consultation.version, { reply_pending: pending });
  const turnId = v7();
  tx.insert(at, 'consultation_turns', { id: turnId, consultation_id: consultation.id, ordinal: turns.length + 1, speaker, ...input, virtual_at: virtualAt, recorded_at: recordedAt });
  return turnId;
}

export function submitQuestion(context: CommandContext, input: z.infer<typeof turnInput>) {
  const version = editEncounter(context);
  const turnId = append(context.tx, context.at, context.targetId, 'clinician', turnInput.parse(input), context.virtualAt, context.recordedAt);
  return { version, turnId };
}

export async function appendPatientReply(tx: StoreTx, at: StoreScope, encounterId: string, questionId: string, reply: z.infer<typeof turnInput>) {
  const epoch = tx.getEpoch(at);
  if (epoch?.status !== 'active') throw new CoreError(409, 'EPOCH_CONFLICT');
  const input = turnInput.parse(reply);
  const key = `patient-reply:${z.uuidv7().parse(questionId)}`;
  const digest = await sha256(JSON.stringify([encounterId, questionId, input.channel, input.content]));
  const receipt = tx.findCommandReceipt(at, key);
  if (receipt) {
    if (receipt.operation !== 'consultation.reply' || receipt.request_hash !== digest) throw new CoreError(409, 'IDEMPOTENCY_CONFLICT');
    return z.uuidv7().parse(receipt.result);
  }
  const encounter = requireEncounter(tx, at, encounterId);
  if (encounter.status !== 'active') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
  const recordedAt = new Date().toISOString();
  const turnId = append(tx, at, encounterId, 'patient', input, epoch.virtual_time, recordedAt, questionId);
  tx.update(at, 'encounters', encounterId, encounter.version, { status: 'active' });
  tx.insert(at, 'audit_events', { id: v7(), actor: 'patient-agent', practitioner_role: 'patient', operation: 'consultation.reply', target_id: turnId, virtual_at: epoch.virtual_time, recorded_at: recordedAt, outcome: 'applied' });
  tx.recordCommandReceipt(at, { id: v7(), operation: 'consultation.reply', idempotency_key: key, request_hash: digest, result: turnId, recorded_at: recordedAt });
  return turnId;
}
