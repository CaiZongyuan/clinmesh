import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProfileStore } from '../src/profile-store.ts'

describe('CLI human profile store', () => {
  it('persists named sessions atomically with restrictive permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-profile-'))
    try {
      const store = createProfileStore({ directory })
      await store.save('doctor', {
        cookie: 'better-auth.session_token=synthetic',
        serverUrl: 'http://127.0.0.1:51868',
      })

      await expect(store.load('doctor')).resolves.toEqual({
        cookie: 'better-auth.session_token=synthetic',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const path = join(directory, 'profiles.json')
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const raw = await readFile(path, 'utf8')
      expect(raw).not.toContain('password')
      expect(raw).not.toContain('agentToken')

      await store.remove('doctor')
      await expect(store.load('doctor')).resolves.toBeUndefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
