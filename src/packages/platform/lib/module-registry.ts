import type { Hono } from 'hono';
import { z } from 'zod';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { localizedName } from './commands';

export const gateItem = z.object({ id: z.string(), label: localizedName, passed: z.boolean() });
export const workbenchTab = z.object({ id: z.string(), label: localizedName });
export type CompletionCheck = (reader: StoreReader, at: StoreScope, encounterId: string) => z.infer<typeof gateItem>[];
type MidnightHook = (tx: StoreTx, at: StoreScope, localDate: string) => void | Promise<void>;

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
  completion?: CompletionCheck;
  midnight?: MidnightHook;
  clockAdvanced?(tx: StoreTx, at: StoreScope, to: string, recordedAt: string): void | Promise<void>;
  workbenchTabs?: readonly z.infer<typeof workbenchTab>[];
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

  enabled(ids: readonly string[]) { return [...this.#modules.values()].filter(module => module.kind === 'core' || ids.includes(module.id)); }
}
