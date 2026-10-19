import type { JsonChatCompletionsProvider } from '../../src/infrastructure/ai/openai-chat-completions.ts'
import { z } from 'zod'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyMigrations, openClinMeshDatabase } from '../../src/infrastructure/sqlite/database.ts'

// Capture HTTP-produced evidence in the schema shipped before verifier retirement.
// Runtime startup, rather than the fixture, must migrate every historical verdict.
export async function replaceWithPreConsolidationDatabase(databasePath: string): Promise<void> {
  const directory = dirname(databasePath)
  const migrationDirectory = join(directory, 'pre-consolidation-migrations')
  await mkdir(migrationDirectory)
  const migrations = (await readdir(join(process.cwd(), 'drizzle')))
    .filter(file => /^\d{4}_.+\.sql$/u.test(file) && file < '0066_')
  await Promise.all(migrations.map(file => copyFile(join(process.cwd(), 'drizzle', file), join(migrationDirectory, file))))
  const legacyPath = join(directory, 'pre-consolidation.sqlite')
  const legacy = openClinMeshDatabase({ databasePath: legacyPath, busyTimeoutMs: 5_000 })
  try {
    applyMigrations(legacy, migrationDirectory)
    legacy.driver.pragma('foreign_keys = OFF')
    legacy.driver.prepare('ATTACH DATABASE ? AS captured').run(databasePath)
    const tables = z.array(z.object({ name: z.string() })).parse(legacy.driver.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migration' ORDER BY name`).all())
    legacy.driver.transaction(() => {
      for (const { name } of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`
        const columns = z.array(z.object({ name: z.string() })).parse(legacy.driver.pragma(`table_info(${quoted})`))
        const list = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
        legacy.driver.exec(`INSERT OR REPLACE INTO ${quoted} (${list}) SELECT ${list} FROM captured.${quoted}`)
      }
    })()
    legacy.driver.exec('DETACH DATABASE captured')
    legacy.driver.pragma('foreign_keys = ON')
    if (z.array(z.unknown()).parse(legacy.driver.pragma('foreign_key_check')).length !== 0) throw new Error('Invalid pre-consolidation database fixture')
  } finally { legacy.close() }
  await copyFile(legacyPath, databasePath)
}

// Translate legacy state-machine fixtures at the fixture boundary. Native
// sentence-protocol tests return sourceIds directly and do not use this adapter.
export function sentenceReferenceFixtureResponse(value: unknown, payload: unknown): unknown {
  const input = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string(),
    sentences: z.array(z.object({ id: z.string(), text: z.string() })) })) }).safeParse(payload)
  const output = z.object({ additions: z.array(z.object({ facts: z.array(z.object({
    sources: z.array(z.object({ sourceTurnId: z.string(), quote: z.string() })).optional(),
  }).passthrough()) }).passthrough()) }).passthrough().safeParse(value)
  if (!input.success || !output.success) return value
  return { ...output.data, additions: output.data.additions.map(addition => ({ ...addition,
    facts: addition.facts.map(({ sources, ...fact }) => sources === undefined ? fact : { ...fact,
      sourceIds: sources.flatMap(source => {
        const turn = input.data.turns.find(turn => turn.id === source.sourceTurnId)
        const range = turn === undefined ? undefined : findCompleteStatementQuote(turn.messageText, source.quote)
        if (turn === undefined || range === undefined) return ['unknown-sentence-reference']
        let cursor = 0
        return turn.sentences.filter(sentence => {
          const start = turn.messageText.indexOf(sentence.text, cursor)
          cursor = start + sentence.text.length
          return start >= range.start && start < range.end && (cursor <= range.end
            || /^[。！？；!?;]+$/u.test(turn.messageText.slice(range.end, cursor)))
        }).map(sentence => sentence.id)
      }),
    }),
  })) }
}

// Older state-machine regressions use extract-shaped fixtures. Keep their text
// and fragment boundaries while exercising the new wire contract. Summary
// quality is covered separately with paraphrased multi-turn facts.
export function recordingFixtureProvider(provider: JsonChatCompletionsProvider,
  quality?: JsonChatCompletionsProvider['completeJson']): JsonChatCompletionsProvider {
  return {
    ...(provider.resolveModel === undefined ? {} : { resolveModel: provider.resolveModel.bind(provider) }),
    async completeJson(input) {
      if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
        if (quality !== undefined) return quality(input)
        const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })),
          recordingContext: z.object({ changes: z.array(z.object({ id: z.string() })) }).optional() }).parse(input.userPayload)
        return { model: 'synthetic', content: JSON.stringify({ issues: [],
          agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
          ...(payload.recordingContext === undefined ? {} : { recordingChecks: payload.recordingContext.changes.map(change => ({
            id: change.id, preserved: true, relationValid: true, rejectionValid: true,
          })) }),
        }) }
      }
      if (input.schemaName !== 'consultation_history_summary') return provider.completeJson(input)
      const convert = (value: unknown) => {
        const output = value as { additions?: Array<{ field: string; quote?: string; sourceTurnId?: string;
          relation: string; targetAdditionId?: string; facts?: unknown }> }
        if (!Array.isArray(output?.additions)) return value
        return sentenceReferenceFixtureResponse({ ...output, additions: output.additions.flatMap(addition => {
          if (addition.facts !== undefined) return [addition]
          const { quote, sourceTurnId, ...rest } = addition
          const quotes = addition.relation === 'addition' && typeof quote === 'string'
            ? (quote.match(/.*?(?:[。！？!?；;\n]+|$)/gs) ?? []).map(text => text.trim()).filter(Boolean) : [quote]
          return quotes.map(quote => ({ ...rest, facts: [{ text: `患者自述：${quote}`, sources: [{ sourceTurnId, quote }] }] }))
        }) }, input.userPayload)
      }
      const result = await provider.completeJson({ ...input, schemaName: 'consultation_history_increment',
        ...(input.validate === undefined ? {} : { validate: value => input.validate!(convert(value)) }) })
      return { ...result, content: JSON.stringify(convert(JSON.parse(result.content))) }
    },
  }
}
