import { z } from 'zod';
import type { StorePort, StoreReader } from '../../store';
import { authorize, commandEnvelope, executeCommand, resolveActor, type Actor, type CommandContext, type Route } from './commands';
import { CoreError, type Credential } from './visitor-gate';

export type ReadContext = { reader: StoreReader; actor: Actor; targetId: string; params?: Readonly<Record<string, string>> };
type Call = { store: StorePort; credential: Credential; targetId: string; params?: ReadContext['params']; body(): Promise<unknown>; providerHeaders?: Headers };
type Result = z.core.util.JSONType;
type Definition = Route & { input: z.ZodType; output: z.ZodType; invoke(call: Call): Promise<Result> };

export class OperationCatalog {
  readonly #entries: Definition[] = [];
  constructor(private readonly moduleId?: string) {}
  get entries(): readonly Definition[] { return this.#entries; }

  contribute(moduleId: string | undefined, register: (catalog: OperationCatalog) => void) {
    const contribution = new OperationCatalog(moduleId);
    register(contribution);
    for (const entry of contribution.entries) this.add(entry);
  }

  private add(entry: Definition) {
    if (this.#entries.some(item => item.name === entry.name || (item.method === entry.method && item.path === entry.path))) throw Error(`Duplicate operation: ${entry.name}`);
    this.#entries.push(entry);
  }

  query<Output extends Result>(route: Omit<Route, 'method'>, output: z.ZodType<Output>, read: (context: ReadContext) => Output) {
    route = { ...route, moduleId: this.moduleId ?? route.moduleId };
    this.add({ ...route, method: 'GET', input: z.strictObject({}), output, invoke: ({ store, credential, targetId, params }) => store.read(reader => {
      const actor = resolveActor(reader, credential, new Date().toISOString());
      authorize(actor, route);
      return output.parse(read({ reader, actor, targetId, params }));
    }) });
  }

  command<Fields extends z.ZodRawShape, Output extends Result, Prepared = undefined>(route: Route, fields: Fields, output: z.ZodType<Output>,
    apply: (context: CommandContext, input: z.output<z.ZodObject<Fields>>, prepared: Prepared, providerHeaders?: Headers) => Output | Promise<Output>,
    disclosure?: { firstOutput: z.ZodType<Result>; prepare(actor: Actor, input: z.output<z.ZodObject<Fields>>): Promise<{ value: Prepared; firstResponse: Record<string, string> }> }) {
    route = { ...route, moduleId: this.moduleId ?? route.moduleId };
    const input = commandEnvelope.extend(fields).strict();
    this.add({ ...route, input, output: disclosure ? z.union([disclosure.firstOutput, output]) : output, async invoke({ store, credential, targetId, body, providerHeaders }) {
      const actor = await store.read(reader => resolveActor(reader, credential, new Date().toISOString()));
      authorize(actor, route);
      const parsed = input.parse(await body());
      const args = parsed as z.output<z.ZodObject<Fields>>;
      const prepared = await disclosure?.prepare(actor, args);
      let firstResponse: Result | undefined;
      const execution = await executeCommand(store, credential, route, targetId, parsed as z.infer<typeof commandEnvelope>, async context => {
        const receipt = output.parse(await apply(context, args, prepared?.value as Prepared, providerHeaders));
        if (disclosure && prepared) firstResponse = disclosure.firstOutput.parse({ ...z.record(z.string(), z.json()).parse(receipt), ...prepared.firstResponse });
        return receipt;
      });
      if (!execution.replay && firstResponse !== undefined) return firstResponse;
      return output.parse(execution.result);
    } });
  }

  require(name: string) {
    const entry = this.entries.find(item => item.name === name);
    if (!entry) throw new CoreError(400, 'UNKNOWN_OPERATION');
    return entry;
  }
}
