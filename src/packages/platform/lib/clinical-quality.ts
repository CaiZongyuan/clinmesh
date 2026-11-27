import { z } from 'zod';
import { compatibleInput, trimmedInput } from '../../operation-catalog';

export const overrideReasons = ['contraindication-or-bleeding-risk', 'outside-result-verified', 'follow-up-arranged', 'informed-refusal', 'specialist-judgment', 'emergency-priority'] as const;
export const overrideSchema = z.strictObject({ reasonCode: z.enum(overrideReasons), note: trimmedInput(4, 2000), ruleCodes: z.array(z.string().min(1)).nonempty().max(16) });
export const clinicalOverrideInput = compatibleInput(z.unknown().optional(), overrideSchema.optional());

type MedicationIntent = { codeSystem: string; code: string; dose: number; timesPerDay: number };
export type ClinicalQualityIntent = { encounterId: string } & (
  | { kind: 'medication'; lines: readonly MedicationIntent[]; activeMedicationIds?: readonly string[] }
  | { kind: 'investigation'; catalogItemIds: readonly string[] }
  | { kind: 'complete' }
  | { kind: 'pci'; ffr?: number }
  | { kind: 'discharge'; completedPci?: boolean; activeMedicationIds?: readonly string[] }
);
