import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default async function globalSetup() {
  const runDir = await mkdtemp(join(tmpdir(), 'clinmesh-e2e-run-'))
  process.env.CLINMESH_E2E_RUN_DIR = runDir
  return async () => {
    await rm(runDir, { recursive: true, force: true })
  }
}
