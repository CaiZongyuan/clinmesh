import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentEnvironment, EvaluationGateway, ExecutionEnvironmentPort, ExecutionEnvironments } from '../packages/agent-runtime';
import { createNodeSqliteStore } from '../packages/store';
import { builtinModules } from './builtin-modules';
import { evaluationResult, type EvaluationHost } from './evaluation-host';
import { createWorkspaceApp } from './workspace';

export function nodeEvaluations(directory: string, environment: AgentEnvironment): EvaluationHost {
  type Open = (gateway: EvaluationGateway) => ExecutionEnvironmentPort | Promise<ExecutionEnvironmentPort>;
  const load = {
    'host-cli': async () => (await import('./node-evaluation-cli')).openCliEnvironment,
    'ui-sdk-webmcp': async () => (await import('./node-evaluation-webmcp')).openWebMcpEnvironment,
    'mirage-vfs': async () => (await import('../packages/mod-agent-mirage')).openMirageEnvironment,
  };
  const path = (runId: string) => join(directory, `${z.uuidv7().parse(runId)}.sqlite`);
  return {
    async start(launch, request) {
      const environments: ExecutionEnvironments = {};
      const arm = launch.spec.arm;
      if (arm !== 'direct-tools') {
        let open: Open;
        try { open = await load[arm](); } catch { return Response.json({ code: 'EVALUATION_ARM_UNAVAILABLE', arm }, { status: 503 }); }
        environments[arm] = async gateway => open(gateway);
      }
      mkdirSync(directory, { recursive: true });
      const dbPath = path(launch.runId);
      const store = createNodeSqliteStore({ dbPath });
      let published = false;
      try {
        const result = await createWorkspaceApp(store, {}, builtinModules, environment).runEvaluation(launch, request, environments);
        published = result.ok;
        return result;
      } finally {
        await store.close();
        if (!published) for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
      }
    },
    async read(runId) {
      const dbPath = path(runId);
      if (!existsSync(dbPath)) return Response.json({ code: 'EVALUATION_NOT_FOUND' }, { status: 404 });
      const store = createNodeSqliteStore({ dbPath });
      try { return await evaluationResult(store, runId); } finally { await store.close(); }
    },
  };
}
