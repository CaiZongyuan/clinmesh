import { z } from 'zod'
import { roleCodeSchema } from './his.ts'

export const agentClientSchema = z.object({
  actorId: z.string().min(1),
  agentClientId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  name: z.string().min(1).max(100),
  status: z.enum(['active', 'disabled']),
}).strict()

export const agentClientListSchema = z.object({
  items: z.array(agentClientSchema),
}).strict()

export const createAgentClientInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
}).strict()

export const agentCapabilityGrantSchema = z.object({
  agentClientId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  grantId: z.uuid(),
  operationIds: z.array(z.string().min(1)).min(1),
  practitionerRoleId: z.string().min(1),
  token: z.string().regex(/^cma_[a-f0-9]{40}$/),
}).strict()

export const agentCapabilityGrantViewSchema = z.object({
  agentClientId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  grantId: z.uuid(),
  operationIds: z.array(z.string().min(1)).min(1),
  practitionerRoleId: z.string().min(1),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['active', 'expired', 'invalidated', 'revoked']),
}).strict()

export const agentCapabilityGrantListSchema = z.object({
  items: z.array(agentCapabilityGrantViewSchema),
}).strict()

export const createAgentCapabilityGrantInputSchema = z.object({
  agentClientId: z.uuid(),
  operationIds: z.array(z.string().min(1)).min(1),
  practitionerRoleId: z.string().min(1),
  ttlSeconds: z.number().int().min(60).max(86_400),
}).strict()

export const revokedAgentCapabilityGrantSchema = z.object({
  grantId: z.uuid(),
  revokedAt: z.iso.datetime({ offset: true }),
  status: z.literal('revoked'),
}).strict()

export const agentCapabilityContextSchema = z.object({
  actor: z.object({
    actorId: z.string().min(1),
    epoch: z.string().min(1),
    locationId: z.string().min(1),
    organizationId: z.string().min(1),
    practitionerId: z.string().min(1),
    practitionerRoleId: z.string().min(1),
    roleCode: roleCodeSchema,
    scenarioRunId: z.string().min(1),
    workspaceId: z.string().min(1),
  }).strict(),
  agent: z.object({
    agentClientId: z.uuid(),
    name: z.string().min(1),
  }).strict(),
  grant: z.object({
    expiresAt: z.iso.datetime({ offset: true }),
    grantId: z.uuid(),
    operationIds: z.array(z.string().min(1)).min(1),
    policyVersion: z.number().int().positive(),
  }).strict(),
}).strict()
