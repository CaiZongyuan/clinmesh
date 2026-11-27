import { create } from 'zustand';
import type { EncounterView } from '../packages/clinical-core';

export type StagedMember = { catalogId: string; codeSystem: string; code: string; kind: string };
type Drafts = { orderSet?: { templateId: string; executionId?: string; members: StagedMember[] }; note?: { fields: Record<string, string>; version: number }; diagnoses?: { items: EncounterView['diagnoses']; baseline: EncounterView['diagnoses']; version: number }; acknowledgedVersion: number };
export const createEncounterDrafts = () => create<Drafts>(() => ({ acknowledgedVersion: 0 }));
export type EncounterDrafts = ReturnType<typeof createEncounterDrafts>;
const emptyDrafts = createEncounterDrafts();
export const useOrderSetDraft = (drafts: EncounterDrafts = emptyDrafts) => drafts(state => state.orderSet);
export function consumeStagedMembers(drafts: EncounterDrafts | undefined, accepted: (member: StagedMember) => boolean) {
  drafts?.setState(({ orderSet }) => ({ orderSet: orderSet && { ...orderSet, members: orderSet.members.filter(member => !accepted(member)) } }));
}

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
