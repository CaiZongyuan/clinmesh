import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

export const test=base.extend<{source:Awaited<ReturnType<typeof startConsultationCase>>}>({
  browserApp:async({webRoot},use)=>{
    const directory=await mkdtemp(join(tmpdir(),'clinmesh-inpatient-investigations-e2e-'))
    try {
      const referenceDatabasePath=await createInvestigationReferenceDatabase(directory)
      const app=await startBrowserServer(webRoot,{referenceDatabasePath,activeReferenceReleaseId:'investigation-e2e-v1',patientPersonaModel:'synthetic-persona',syntheaProvider:new class extends StubSyntheaProvider {
          override async generate() {
            const corpus=await super.generate()
            return {...corpus,sources:corpus.sources.map(source=>{
              const raw=z.object({entry:z.array(z.object({resource:z.record(z.string(),z.unknown())}).passthrough())}).passthrough().parse(source.raw)
              raw.entry.find(entry=>entry.resource.id==='iwtest')!.resource.valueQuantity={value:11.2,code:'10*9/L',unit:'10*9/L',system:'http://unitsofmeasure.org'}
              raw.entry.find(entry=>entry.resource.id==='ihtest')!.resource.valueQuantity={value:135,code:'g/L',unit:'g/L',system:'http://unitsofmeasure.org'}
              return {...source,raw,hash:sourceArtifactHash(raw)}
            })}
          }
        }(),
        chatCompletionsProvider:{completeJson:async input=>({model:input.model,content:JSON.stringify(persona)})}})
      try {await use(app)} finally {await app.close()}
    } finally {await rm(directory,{recursive:true,force:true})}
  },
  source:async({browserApp},use)=>{await use(await startConsultationCase(browserApp.runtime,browserApp.password,browserApp.origin))},
})

export { expect }
