import type { Hono } from 'hono';
import { z } from 'zod';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { localizedName, type Actor, type ClinicalQualityGate, type CommandContext, type EncounterWrite } from './commands';

export const gateItem = z.object({ id: z.string(), label: localizedName, passed: z.boolean() });
export const workbenchTab = z.object({ id: z.string(), label: localizedName, readOperation: z.string().optional() });
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
  availableInEpoch?(reader: StoreReader, at: StoreScope): boolean;
  registerRoutes?(app: Hono): void;
  registerOperations?(catalog: Operations): void;
  initializeEpoch?(tx: StoreTx, at: StoreScope, virtualAt: string, recordedAt: string): void | Promise<void>;
  encounterStarted?(tx: StoreTx, at: StoreScope, encounterId: string, virtualAt: string, recordedAt: string): void;
  guardEncounter?(context: CommandContext, write: EncounterWrite): void;
  completion?: CompletionCheck;
  clinicalQuality?: ClinicalQualityGate;
  projection?: { base: string; respond(request: Request, reader: StoreReader, actor: Actor): Response };
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

  async initializeEpoch(enabled: readonly string[], tx: StoreTx, at: StoreScope, virtualAt: string, recordedAt: string) {
    for (const module of this.enabled(enabled)) await module.initializeEpoch?.(tx, at, virtualAt, recordedAt);
  }

  health(runtime: RuntimeHealth['runtime']): RuntimeHealth {
    return { ok: true, runtime, loadedModules: [...this.#modules.keys()] };
  }

  enabled(ids: readonly string[], reader?: StoreReader, at?: StoreScope) {
    return [...this.#modules.values()].filter(module => (module.kind === 'core' || ids.includes(module.id)) && (!reader || !at || module.availableInEpoch?.(reader, at) !== false));
  }
}
