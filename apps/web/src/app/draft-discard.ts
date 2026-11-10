/** 显式丢弃前直接检查当前原文，避免其他坏稿阻塞读取后遮蔽未知尝试。读取失败继续抛出。 */
export function hasUnknownDraftAttempt(key: string): boolean {
  const raw = sessionStorage.getItem(key)
  let record: unknown
  try { record = JSON.parse(raw ?? 'null') } catch { return false }
  return record !== null && typeof record === 'object' && 'items' in record && Array.isArray(record.items)
    && record.items.some((item: unknown) => item !== null && typeof item === 'object' && 'status' in item && item.status === 'unknown')
}

/** 退出清理先作废整个私稿命名空间；存储恢复前不允许读回旧内容。 */
export function createDraftDiscard(prefix: string, onDiscard: () => void = () => undefined,
  retain: (key: string, raw: string) => string | null = () => null) {
  const marker = `clinmesh.draft-discard:v1:${encodeURIComponent(prefix)}`
  let pending = false
  const ensureCleared = () => {
    if (!pending && sessionStorage.getItem(marker) === null) return
    pending = true
    for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
      const raw = sessionStorage.getItem(key)
      if (raw === null) continue
      const retained = retain(key, raw)
      if (retained === null) sessionStorage.removeItem(key)
      else if (retained !== raw) sessionStorage.setItem(key, retained)
    }
    sessionStorage.removeItem(marker)
    pending = false
  }
  return {
    ensureCleared,
    read(key: string) { ensureCleared(); return sessionStorage.getItem(key) },
    clear() {
      pending = true
      try {
        try { sessionStorage.setItem(marker, '1') } catch { /* 存储完全不可用时仍由内存标记阻止本次会话恢复。 */ }
        ensureCleared()
      } finally { onDiscard() }
    },
  }
}
