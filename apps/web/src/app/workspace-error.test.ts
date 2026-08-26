import { describe, expect, it } from 'vitest'
import { ApiClientError } from './api-client.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

function signedConflict(owner: 'clinical-document' | 'prescription') {
  return new ApiClientError(409, 'WORKFLOW_CONFLICT', 'The resource is signed', {
    currentStatus: 'signed',
    owner,
    resource: owner === 'clinical-document'
      ? 'Composition/composition-1'
      : 'Prescription/prescription-1',
  })
}

describe('workspace conflict messages', () => {
  it('maps a shared signed status according to its clinical owner', () => {
    expect(getWorkspaceErrorMessage(
      signedConflict('clinical-document'),
      getWorkspaceMessages('zh-CN'),
    )).toBe('病历当前状态为“已签署”。请刷新后重新确认。')
    expect(getWorkspaceErrorMessage(
      signedConflict('prescription'),
      getWorkspaceMessages('zh-CN'),
    )).toBe('处方当前状态为“已开具”。请刷新后重新确认。')
    expect(getWorkspaceErrorMessage(
      signedConflict('clinical-document'),
      getWorkspaceMessages('en-US'),
    )).toBe('Clinical document is currently “Signed”. Refresh and confirm again.')
    expect(getWorkspaceErrorMessage(
      signedConflict('prescription'),
      getWorkspaceMessages('en-US'),
    )).toBe('Prescription is currently “Issued”. Refresh and confirm again.')
  })
})
