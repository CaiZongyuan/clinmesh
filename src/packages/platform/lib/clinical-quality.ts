import type { CommandContext } from './commands';

type MedicationIntent = { codeSystem: string; code: string; dose: number; timesPerDay: number };
export type ClinicalQualityIntent = { encounterId: string } & (
  | { kind: 'medication'; lines: readonly MedicationIntent[]; activeMedicationIds?: readonly string[] }
  | { kind: 'investigation'; catalogItemIds: readonly string[] }
  | { kind: 'complete' }
  | { kind: 'pci'; ffr?: number }
  | { kind: 'discharge'; completedPci?: boolean; activeMedicationIds?: readonly string[] }
);
export type ClinicalQualityGate = (context: CommandContext, intent: ClinicalQualityIntent, clinicalOverride: unknown, operation: string) => void;
