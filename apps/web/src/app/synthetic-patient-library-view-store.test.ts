import { beforeEach, describe, expect, it } from 'vitest'
import { useSyntheticPatientLibraryViewStore } from './synthetic-patient-library-view-store.ts'

describe('Synthetic Patient Library view state', () => {
  beforeEach(() => {
    useSyntheticPatientLibraryViewStore.getState().reset()
  })

  it('keeps current generation jobs isolated by Workspace and Synthetic Case', () => {
    const store = useSyntheticPatientLibraryViewStore.getState()

    store.setScenarioGenerationJob('workspace-a', 'generation-job-a')
    store.setScenarioGenerationJob('workspace-b', 'generation-job-b')
    store.setPatientBriefJob('case-a', 'brief-job-a')
    store.setPatientBriefJob('case-b', 'brief-job-b')

    expect(useSyntheticPatientLibraryViewStore.getState()).toMatchObject({
      patientBriefJobIds: {
        'case-a': 'brief-job-a',
        'case-b': 'brief-job-b',
      },
      scenarioGenerationJobIds: {
        'workspace-a': 'generation-job-a',
        'workspace-b': 'generation-job-b',
      },
    })
  })
})
