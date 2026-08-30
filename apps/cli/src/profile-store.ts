import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const humanProfileSchema = z.object({
  cookie: z.string().min(1),
  serverUrl: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
}).strict()

const profileDocumentSchema = z.object({
  profiles: z.record(z.string().min(1), humanProfileSchema),
  version: z.literal(1),
}).strict()

export type HumanProfile = z.infer<typeof humanProfileSchema>

interface ProfileStoreOptions {
  directory: string
}

export interface ProfileStore {
  load: (name: string) => Promise<HumanProfile | undefined>
  remove: (name: string) => Promise<void>
  save: (name: string, profile: HumanProfile) => Promise<void>
}

async function readDocument(path: string): Promise<z.infer<typeof profileDocumentSchema>> {
  try {
    return profileDocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { profiles: {}, version: 1 }
    }
    throw error
  }
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const path = join(options.directory, 'profiles.json')

  const writeDocument = async (document: z.infer<typeof profileDocumentSchema>) => {
    await mkdir(options.directory, { mode: 0o700, recursive: true })
    await chmod(options.directory, 0o700)
    const temporaryPath = join(options.directory, `.profiles-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporaryPath, path)
      await chmod(path, 0o600)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  return {
    async load(name: string): Promise<HumanProfile | undefined> {
      return (await readDocument(path)).profiles[name]
    },
    async remove(name: string): Promise<void> {
      const document = await readDocument(path)
      Reflect.deleteProperty(document.profiles, name)
      await writeDocument(document)
    },
    async save(name: string, profile: HumanProfile): Promise<void> {
      const document = await readDocument(path)
      document.profiles[name] = humanProfileSchema.parse(profile)
      await writeDocument(document)
    },
  }
}
