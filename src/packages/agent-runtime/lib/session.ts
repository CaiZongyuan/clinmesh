import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, type HarnessOptions } from '@earendil-works/pi-durable';
import type { AgentRole } from '../../agent-protocol';
import { CoreError } from '../../platform';
import type { StorePort, StoreScope } from '../../store';

export async function openDurableAgentSession(store: StorePort, at: StoreScope, id: string, role: AgentRole, options: HarnessOptions) {
  const session = await store.read(reader => reader.get(at, 'pi_sessions', id));
  if (session?.agent !== role) throw new CoreError(404, 'AGENT_SESSION_NOT_FOUND');
  return Harness.open(await store.openPiStorage(at, id), options, BACKGROUND_CONTEXT);
}
