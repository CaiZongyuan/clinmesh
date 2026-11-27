import { z } from 'zod';

export type OperationMode = 'query' | 'preview' | 'command';
export const receiptOperationId = 'command.receipt.get';
export type OperationRisk = 'read' | 'write' | 'high-risk-write';
const compatibilityFields = new WeakMap<z.core.$ZodType, z.ZodType | null>();

export function compatibleInput<Accepted extends z.ZodType>(accepted: Accepted, published: z.ZodType | null): Accepted {
  compatibilityFields.set(accepted, published);
  return accepted;
}
export type OperationRoute = {
  name: string; method: 'GET' | 'POST' | 'PUT'; path: string; moduleId?: string;
  access: { capabilities?: readonly string[]; visitorOnly?: boolean };
  cliPath?: string; version?: number; mode?: 'preview'; risk?: 'write'; expectedVersionFields?: string[]; pathParams?: Record<string, z.ZodType<string>>;
};

export function defineOperation(route: OperationRoute, body: z.ZodObject, outputSchema: z.ZodType, entityId: z.ZodType<string>, queryFields: z.ZodRawShape = {}) {
  const write = route.method !== 'GET';
  const mode: OperationMode = write ? route.mode ?? 'command' : 'query';
  const risk: OperationRisk = write ? route.risk ?? (mode === 'preview' ? 'write' : 'high-risk-write') : 'read';
  const pathFields = Array.from(route.path.matchAll(/:(\w+)/g), match => match[1]!);
  const pathShape = Object.fromEntries(pathFields.map(field => [field, route.pathParams?.[field] ?? entityId]));
  if (pathFields.some(field => Object.hasOwn(body.shape, field) || Object.hasOwn(queryFields, field))) throw Error(`Ambiguous path field on ${route.name}`);
  const paramsSchema = z.strictObject({ ...pathShape, ...queryFields });
  const published = Object.fromEntries(Object.entries(body.shape).flatMap(([name, field]) => {
    const schema = compatibilityFields.get(field);
    return schema === null ? [] : [[name, schema ?? field]];
  }));
  const inputSchema = z.strictObject({ ...published, ...paramsSchema.shape });
  const expectedVersionFields = write ? [...Object.keys(body.shape).filter(field => /(?:Version|Revision)$|^revision$/.test(field)), ...(route.expectedVersionFields ?? [])] : [];
  if (expectedVersionFields.some(field => !Object.hasOwn(body.shape, field.split(/[.[]/)[0]!))) throw Error(`Unknown version precondition on ${route.name}`);
  return { id: route.name, version: route.version ?? 1, cliPath: route.cliPath ?? route.name.replaceAll('.', ' '), mode, risk,
    moduleId: route.moduleId ?? 'core', allowedCapabilities: route.access.capabilities ?? [], visitorOnly: route.access.visitorOnly ?? false,
    http: { method: route.method, path: route.path }, requiresIdempotencyKey: write, expectedVersionFields,
    pathFields, queryFields: Object.keys(queryFields), paramsSchema, inputSchema, outputSchema };
}

export type Operation = ReturnType<typeof defineOperation>;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, override({ jsonSchema }) {
    // Zod's JSON Schema reader needs the string type on each intersected pattern.
    if (jsonSchema.type === 'string') for (const check of jsonSchema.allOf ?? []) if (check.pattern) check.type = 'string';
  } });
}

export function describeOperation({ inputSchema, outputSchema, paramsSchema: _params, ...metadata }: Operation) {
  return { ...metadata, inputSchema: jsonSchema(inputSchema, 'input'), outputSchema: jsonSchema(outputSchema, 'output') };
}

export type OperationDescription = ReturnType<typeof describeOperation>;

function distinct(values: readonly unknown[], property?: string) {
  const keys = property ? values.map(value => (value as Record<string, unknown>)[property]) : values;
  return new Set(keys).size === keys.length;
}

export function distinctInput<Schema extends z.ZodArray>(schema: Schema, property?: string) {
  return schema.refine(values => distinct(values, property)).meta({ uniqueItems: true, ...(property && { 'x-clinmesh-uniqueBy': property }) });
}

export function trimmedInput(minLength: number, maxLength: number, pattern?: RegExp) {
  const text = z.string().trim().min(minLength).max(maxLength);
  return (pattern ? text.regex(pattern) : text).meta({ 'x-clinmesh-trim': true });
}

type FieldSchema = z.core.JSONSchema.JSONSchema | boolean | undefined;
function normalizeInput(field: FieldSchema, value: unknown): unknown {
  if (!field || typeof field !== 'object') return value;
  if (typeof value === 'string' && 'x-clinmesh-trim' in field && field['x-clinmesh-trim'] === true) return value.trim();
  if (Array.isArray(value) && field.items && !Array.isArray(field.items)) {
    const item = field.items;
    return value.map(member => normalizeInput(item, member));
  }
  if (field.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = field.properties;
    return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, normalizeInput(properties[name], member)]));
  }
  return value;
}

export function inputValidator(operation: OperationDescription) {
  const schema = z.fromJSONSchema(operation.inputSchema);
  if (!(schema instanceof z.ZodObject)) throw Error('Invalid catalog input contract');
  return z.preprocess(input => normalizeInput(operation.inputSchema, input), schema).superRefine((input, context) => {
    for (const [name, field] of Object.entries(operation.inputSchema.properties ?? {})) {
      const property = typeof field === 'object' && 'x-clinmesh-uniqueBy' in field ? field['x-clinmesh-uniqueBy'] : undefined;
      const values = input[name];
      if (typeof property === 'string' && Array.isArray(values) && !distinct(values, property)) context.addIssue({ code: 'custom', path: [name], message: `Expected distinct ${property} values` });
    }
  });
}

export function operationRequest(operation: OperationDescription, input: Record<string, unknown>) {
  const path = operation.http.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(input[name])));
  const query = new URLSearchParams();
  for (const name of operation.queryFields) query.set(name, String(input[name]));
  const body = operation.requiresIdempotencyKey ? Object.fromEntries(Object.entries(input).filter(([name]) => !operation.pathFields.includes(name))) : undefined;
  return { path: query.size ? `${path}?${query}` : path, body };
}
