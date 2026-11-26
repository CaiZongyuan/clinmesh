import { create } from 'zustand';
import type { EncounterView } from '../packages/clinical-core';

type Drafts = { note?: { fields: Record<string, string>; version: number }; diagnoses?: EncounterView['diagnoses']; acknowledgedVersion: number };
export const createEncounterDrafts = () => create<Drafts>(() => ({ acknowledgedVersion: 0 }));
export type EncounterDrafts = ReturnType<typeof createEncounterDrafts>;

export function createEpochDrafts() {
  const encounters = new Map<string, EncounterDrafts>();
  return (id: string) => {
    const existing = encounters.get(id);
    if (existing) return existing;
    const drafts = createEncounterDrafts();
    encounters.set(id, drafts);
    return drafts;
  };
}
