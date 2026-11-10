import { act } from '@testing-library/react'
import { signOut } from './api-client.ts'

/** 模拟同命名空间坏稿先阻塞退出清理，且原尝试未写成共享意图的存储故障。 */
export async function hideUnknownDraftAtLogout(prefix: string) {
  const key = Object.keys(sessionStorage).find(key => key.startsWith(prefix) && sessionStorage.getItem(key)?.includes('"status":"unknown"'))
  if (!key) throw new Error('Missing the synthetic unknown draft')
  const raw = sessionStorage.getItem(key)!, blocker = `${prefix}synthetic-broken-sibling`
  sessionStorage.removeItem(key)
  sessionStorage.setItem(blocker, '{synthetic-corrupted')
  sessionStorage.setItem(key, raw)
  for (const intentKey of Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.inpatient-intent:'))) sessionStorage.removeItem(intentKey)
  await act(async () => { await signOut() })
  return { key, raw, blocker }
}
