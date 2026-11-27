import type { ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { encounterViewSchema } from '../../clinical-core';
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

const workspaceFacts = z.object({ roleId: z.string(), epoch: z.string(), manifest: z.object({ packId: z.string() }) });
const clinicalFacts = encounterViewSchema.omit({ patient: true, patientId: true }).partial().extend({ patient: z.object({ name: z.string() }) });
export function evaluationProjection(name: string, result: unknown) {
  if (name === 'workspace.read') return workspaceFacts.parse(result);
  if (name === 'encounter.read') return clinicalFacts.parse(result);
  return result;
}

export async function openExecutionEnvironment(arm: ExecutionArm, gateway: EvaluationGateway, hosts: ExecutionEnvironments): Promise<ExecutionEnvironmentPort> {
  if (arm === 'direct-tools') return gateway;
  const open = hosts[arm];
  if (!open) throw new CoreError(503, 'EVALUATION_ARM_UNAVAILABLE');
  return open(gateway);
}
