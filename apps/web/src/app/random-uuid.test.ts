import { afterEach, expect, it, vi } from 'vitest'
import { createRandomUuid } from './random-uuid.ts'

afterEach(() => vi.unstubAllGlobals())

it('preserves the native UUID and its crypto receiver when available', () => {
  const nativeUuid = '00010203-0405-4607-8809-0a0b0c0d0e0f'
  const crypto = { randomUUID() { expect(this).toBe(crypto); return nativeUuid } }
  vi.stubGlobal('crypto', crypto)

  expect(createRandomUuid()).toBe(nativeUuid)
})

it('uses secure random bytes when randomUUID is unavailable on an HTTP origin', () => {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index
  vi.stubGlobal('crypto', {
    getRandomValues(target: Uint8Array) {
      target.set(bytes)
      return target
    },
  })

  expect(createRandomUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
})

it('refuses to generate an identifier without a cryptographic random source', () => {
  vi.stubGlobal('crypto', {})

  expect(() => createRandomUuid()).toThrow()
})
