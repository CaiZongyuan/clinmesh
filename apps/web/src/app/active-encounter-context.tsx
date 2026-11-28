import { create } from 'zustand'

export interface ActiveEncounterContext {
  encounterId: string | null
  caseId: string | null
  patientId: string | null
  patientName: string | null
}

interface ActiveEncounterStore extends ActiveEncounterContext {
  setActiveEncounter: (next: ActiveEncounterContext) => void
  clearActiveEncounter: () => void
}

const EMPTY_ENCOUNTER: ActiveEncounterContext = {
  encounterId: null,
  caseId: null,
  patientId: null,
  patientName: null,
}

export const useActiveEncounterStore = create<ActiveEncounterStore>((set) => ({
  ...EMPTY_ENCOUNTER,
  setActiveEncounter: (next) =>
    set((current) =>
      current.encounterId === next.encounterId
      && current.caseId === next.caseId
      && current.patientId === next.patientId
      && current.patientName === next.patientName
        ? current
        : next,
    ),
  clearActiveEncounter: () => set(EMPTY_ENCOUNTER),
}))
