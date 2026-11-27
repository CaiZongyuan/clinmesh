import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentEnvironment } from '../packages/agent-runtime';
import { createNodeSqliteStore } from '../packages/store';
import { builtinModules } from './builtin-modules';
import { evaluationResult, type EvaluationHost } from './evaluation-host';
import { createWorkspaceApp } from './workspace';

export function nodeEvaluations(directory: string, environment: AgentEnvironment): EvaluationHost {
  const path = (runId: string) => join(directory, `${z.uuidv7().parse(runId)}.sqlite`);
  return {
    async start(launch, request) {
      mkdirSync(directory, { recursive: true });
      const store = createNodeSqliteStore({ dbPath: path(launch.runId) });
      try { return await createWorkspaceApp(store, {}, builtinModules, environment).runEvaluation(launch, request); }
      finally { await store.close(); }
    },
    async read(runId) {
      const dbPath = path(runId);
      if (!existsSync(dbPath)) return Response.json({ code: 'EVALUATION_NOT_FOUND' }, { status: 404 });
      const store = createNodeSqliteStore({ dbPath });
      try { return await evaluationResult(store, runId); } finally { await store.close(); }
    },
  };
}
