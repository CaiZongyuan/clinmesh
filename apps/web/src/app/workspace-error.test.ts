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

  it('localizes transport and protocol failures without exposing internal messages', () => {
    const messages = getWorkspaceMessages('zh-CN')

    expect(getWorkspaceErrorMessage(
      new ApiClientError(0, 'NETWORK_ERROR', 'private network detail'),
      messages,
    )).toBe('无法连接科灵脉智服务，请检查网络连接后重试。')
    expect(getWorkspaceErrorMessage(
      new ApiClientError(0, 'REQUEST_TIMEOUT', 'private timeout detail'),
      messages,
    )).toBe('请求超时，请稍后重试。')
    expect(getWorkspaceErrorMessage(
      new ApiClientError(502, 'UNEXPECTED_RESPONSE', 'private gateway detail'),
      messages,
    )).toBe('服务返回了无法识别的数据，请稍后重试。')
  })

  it('does not expose an unclassified runtime error message', () => {
    expect(getWorkspaceErrorMessage(
      new Error('private implementation detail'),
      getWorkspaceMessages('zh-CN'),
    )).toBe('服务暂时无法完成请求，请稍后重试。')
  })
})
