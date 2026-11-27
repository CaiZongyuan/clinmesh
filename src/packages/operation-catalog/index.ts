import { z } from 'zod';

export type OperationMode = 'query' | 'preview' | 'command';
export type OperationRisk = 'read' | 'write' | 'high-risk-write';
export type OperationRoute = {
  name: string; method: 'GET' | 'POST' | 'PUT'; path: string; moduleId?: string;
  access: { capabilities?: readonly string[]; visitorOnly?: boolean };
  cliPath?: string; version?: number; mode?: 'preview'; risk?: 'write'; expectedVersionFields?: string[];
};

export function defineOperation(route: OperationRoute, body: z.ZodObject, outputSchema: z.ZodType, queryFields: z.ZodRawShape = {}) {
  const write = route.method !== 'GET';
  const mode: OperationMode = write ? route.mode ?? 'command' : 'query';
  const risk: OperationRisk = write ? route.risk ?? (mode === 'preview' ? 'write' : 'high-risk-write') : 'read';
  const pathFields = Array.from(route.path.matchAll(/:(\w+)/g), match => match[1]!);
  const pathShape = Object.fromEntries(pathFields.map(field => [field, z.uuid()]));
  const inputSchema = z.strictObject({ ...body.shape, ...pathShape, ...queryFields });
  const expectedVersionFields = write ? [...Object.keys(body.shape).filter(field => /(?:Version|Revision)$|^revision$/.test(field)), ...(route.expectedVersionFields ?? [])] : [];
  if (expectedVersionFields.some(field => !Object.hasOwn(body.shape, field))) throw Error(`Unknown version precondition on ${route.name}`);
  return { id: route.name, version: route.version ?? 1, cliPath: route.cliPath ?? route.name.replaceAll('.', ' '), mode, risk,
    moduleId: route.moduleId ?? 'core', allowedCapabilities: route.access.capabilities ?? [], visitorOnly: route.access.visitorOnly ?? false,
    http: { method: route.method, path: route.path }, requiresIdempotencyKey: write, expectedVersionFields,
    pathFields, queryFields: Object.keys(queryFields), inputSchema, outputSchema };
}

export type Operation = ReturnType<typeof defineOperation>;

export function describeOperation({ inputSchema, outputSchema, ...metadata }: Operation, schemas = false) {
  return schemas ? { ...metadata, inputSchema: z.toJSONSchema(inputSchema, { io: 'input' }), outputSchema: z.toJSONSchema(outputSchema) } : metadata;
}

export function operationRequest(operation: Operation, fields: unknown) {
  const input = operation.inputSchema.parse(fields);
  const path = operation.http.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(input[name])));
  const query = new URLSearchParams();
  for (const name of operation.queryFields) query.set(name, String(input[name]));
  const body = operation.requiresIdempotencyKey ? Object.fromEntries(Object.entries(input).filter(([name]) => !operation.pathFields.includes(name))) : undefined;
  return { path: query.size ? `${path}?${query}` : path, body };
}
