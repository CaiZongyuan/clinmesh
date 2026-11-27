import type { ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';
import type { Operation } from '../../operation-catalog';
import { CoreError } from '../../platform';

export const executionArm = z.enum(['direct-tools', 'ui-sdk-webmcp', 'host-cli', 'mirage-vfs']);
export type ExecutionArm = z.infer<typeof executionArm>;
export type OperationInput = Record<string, unknown>;
export interface EvaluationGateway {
  readonly roleId: string;
  readonly operations: readonly Operation[];
  readonly encounterId: () => string | undefined;
  invoke(operation: string, input: OperationInput): Promise<unknown>;
}
export interface ExecutionEnvironmentPort {
  invoke(operation: string, input: OperationInput): Promise<unknown>;
  readonly tools?: ToolRegistration[];
  close?(): Promise<void>;
}
export type ExecutionEnvironments = Partial<Record<Exclude<ExecutionArm, 'direct-tools'>, (gateway: EvaluationGateway) => Promise<ExecutionEnvironmentPort>>>;

export async function openExecutionEnvironment(arm: ExecutionArm, gateway: EvaluationGateway, hosts: ExecutionEnvironments): Promise<ExecutionEnvironmentPort> {
  if (arm === 'direct-tools') return gateway;
  const open = hosts[arm];
  if (!open) throw new CoreError(503, 'EVALUATION_ARM_UNAVAILABLE');
  return open(gateway);
}
