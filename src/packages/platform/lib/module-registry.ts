import type { Hono } from 'hono';
import { z } from 'zod';

export function parseRuntimeHealth(payload: unknown) {
  return z.object({
    ok: z.literal(true),
    runtime: z.enum(['cloudflare-worker', 'node']),
    loadedModules: z.array(z.string()),
  }).parse(payload);
}

export type RuntimeHealth = ReturnType<typeof parseRuntimeHealth>;

export interface ClinMeshModule<Operations = never> {
  readonly id: string;
  readonly kind: 'core' | 'clinical' | 'extension';
  readonly version: string;
  registerRoutes?(app: Hono): void;
  registerOperations?(catalog: Operations): void;
}

export class ModuleRegistry<Operations = never> {
  readonly #modules = new Map<string, ClinMeshModule<Operations>>();

  constructor(modules: readonly ClinMeshModule<Operations>[]) {
    for (const module of modules) {
      if (this.#modules.has(module.id)) throw new Error(`Duplicate module ID: ${module.id}`);
      this.#modules.set(module.id, module);
    }
  }

  registerRoutes(app: Hono) {
    for (const module of this.#modules.values()) module.registerRoutes?.(app);
  }

  registerOperations(catalog: Operations) {
    for (const module of this.#modules.values()) module.registerOperations?.(catalog);
  }

  health(runtime: RuntimeHealth['runtime']): RuntimeHealth {
    return { ok: true, runtime, loadedModules: [...this.#modules.keys()] };
  }
}
