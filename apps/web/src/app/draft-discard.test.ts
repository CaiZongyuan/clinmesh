// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createDraftDiscard, hasUnknownDraftAttempt } from './draft-discard.ts'

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear() })

it.each([
  { raw: '{', expected: false },
  { raw: 'null', expected: false },
  { raw: '{"items":[{"status":"ready"}]}', expected: false },
  { raw: '{"items":[{"status":"unknown"}]}', expected: true },
  { raw: '{"scope":"synthetic-invalid","items":[null,{"status":"unknown"},{"status":"unknown"}]}', expected: true },
])('当前原文保留可识别未知尝试，不依赖完整草稿可读：$raw', ({ raw, expected }) => {
  sessionStorage.setItem('synthetic.draft', raw)
  expect(hasUnknownDraftAttempt('synthetic.draft')).toBe(expected)
  expect(sessionStorage.getItem('synthetic.draft')).toBe(raw)
})

it('无法直接读取当前记录时不把它判成可丢弃', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('合成读取失败', 'SecurityError') })
  expect(() => hasUnknownDraftAttempt('synthetic.draft')).toThrow()
})

it('裁剪保存失败后，新模块仍阻止旧输入，存储恢复后保留原恢复键并丢弃未发送内容', () => {
  const prefix = 'synthetic.discard:', key = `${prefix}owner`, original = JSON.stringify({ recoveryKey: 'original-key', unsent: ['synthetic-input'] })
  const retain = (_key: string, raw: string) => JSON.stringify({ recoveryKey: JSON.parse(raw).recoveryKey })
  sessionStorage.setItem(key, original)
  sessionStorage.setItem('synthetic.unrelated', 'keep')
  const notify = vi.fn(), first = createDraftDiscard(prefix, notify, retain)
  const set = Storage.prototype.setItem
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith(prefix)) throw new Error('Synthetic write denied')
    set.call(this, key, value)
  })
  expect(() => first.clear()).toThrow()
  expect(notify).toHaveBeenCalledTimes(1)
  const reloaded = createDraftDiscard(prefix, undefined, retain)
  expect(() => reloaded.read(key)).toThrow()
  denied.mockRestore()
  expect(reloaded.read(key)).toBe(JSON.stringify({ recoveryKey: 'original-key' }))
  expect(sessionStorage.getItem('synthetic.unrelated')).toBe('keep')
  expect(reloaded.read(key)).toBe(JSON.stringify({ recoveryKey: 'original-key' }))
})

it('无法验证原恢复记录时保留原文并阻止读取，修复记录后才允许完成清理', () => {
  const prefix = 'synthetic.discard:', key = `${prefix}owner`
  sessionStorage.setItem(key, '{')
  const discard = createDraftDiscard(prefix, undefined, (_key, raw) => {
    const record: unknown = JSON.parse(raw)
    return record === null ? null : raw
  })
  expect(() => discard.clear()).toThrow()
  expect(sessionStorage.getItem(key)).toBe('{')
  expect(() => discard.read(key)).toThrow()
  sessionStorage.setItem(key, 'null')
  expect(discard.read(key)).toBeNull()
})

it('删除失败的默认私稿在新模块补清理后消失，新输入可正常保存和读取', () => {
  const prefix = 'synthetic.discard:', key = `${prefix}owner`
  sessionStorage.setItem(key, 'old-input')
  const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Synthetic removal denied') })
  expect(() => createDraftDiscard(prefix).clear()).toThrow()
  denied.mockRestore()
  const reloaded = createDraftDiscard(prefix)
  expect(reloaded.read(key)).toBeNull()
  reloaded.ensureCleared()
  sessionStorage.setItem(key, 'new-input')
  expect(reloaded.read(key)).toBe('new-input')
})
