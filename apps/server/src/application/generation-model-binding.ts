import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'

/** Keeps a task's route stable across retries, settings changes and restarts. */
export class GenerationModelBinding {
  constructor(private readonly database: ClinMeshDatabase, private readonly provider: JsonChatCompletionsProvider | undefined) {}

  async bind(workspaceId: string, taskId: string, model: string, signal?: AbortSignal): Promise<string> {
    if (this.provider?.resolveModel === undefined) return model
    const read = () => z.object({ model_id: z.string().min(1).max(1024) }).optional().parse(
      this.database.driver.prepare('SELECT model_id FROM ai_model_binding WHERE workspace_id = ? AND task_id = ?')
        .get(workspaceId, taskId),
    )
    const existing = read()
    if (existing !== undefined) return existing.model_id
    const resolved = await this.provider.resolveModel(model, signal)
    if (signal?.aborted) throw new Error('Model selection was cancelled')
    this.database.driver.prepare('INSERT OR IGNORE INTO ai_model_binding (workspace_id, task_id, model_id) VALUES (?, ?, ?)')
      .run(workspaceId, taskId, resolved)
    // Concurrent callers use the first committed selection.
    return read()!.model_id
  }
}
