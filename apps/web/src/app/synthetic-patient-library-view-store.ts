import { create } from 'zustand'

interface SyntheticPatientLibraryViewState {
  patientBriefJobIds: Record<string, string>
  reset: () => void
  scenarioGenerationJobIds: Record<string, string>
  setPatientBriefJob: (caseId: string, jobId: string) => void
  setScenarioGenerationJob: (workspaceId: string, jobId: string) => void
}

export const useSyntheticPatientLibraryViewStore = create<SyntheticPatientLibraryViewState>(set => ({
  patientBriefJobIds: {},
  reset: () => set({
    patientBriefJobIds: {},
    scenarioGenerationJobIds: {},
  }),
  scenarioGenerationJobIds: {},
  setPatientBriefJob: (caseId, jobId) => set(state => ({
    patientBriefJobIds: {
      ...state.patientBriefJobIds,
      [caseId]: jobId,
    },
  })),
  setScenarioGenerationJob: (workspaceId, jobId) => set(state => ({
    scenarioGenerationJobIds: {
      ...state.scenarioGenerationJobIds,
      [workspaceId]: jobId,
    },
  })),
}))
