import { z } from 'zod';
import type { Actor, ClinMeshModule, OperationCatalog } from '../platform';
import type { StoreReader } from '../store';
import { projectResources, types, type ResourceType } from './lib/resources';

const base = '/fhir/R5';
const media = 'application/fhir+json; charset=utf-8';
const fhirId = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const referenceSearch = z.string().regex(/^(?:(Patient|Encounter)\/)?[A-Za-z0-9.-]{1,64}$/);
const resourceTypes = z.enum(types);
const interactions = ['read', 'vread', 'history-instance', 'history-type', 'search-type'].map(code => ({ code }));
function parameters(type: ResourceType) {
  if (type === 'Patient' || type === 'AuditEvent') return ['_id'];
  if (type === 'Encounter') return ['_id', 'patient'];
  return ['_id', 'patient', 'encounter'];
}
function json(value: unknown, status = 200, headers?: Record<string, string>) { return Response.json(value, { status, headers: { 'content-type': media, ...headers } }); }
function failure(status: number, code: string, diagnostics: string) {
  return json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] }, status, status === 405 ? { allow: 'GET' } : undefined);
}
function capability(root: string) {
  return { resourceType: 'CapabilityStatement', status: 'active', date: '2026-11-27', kind: 'instance', fhirVersion: '5.0.0', format: ['json'],
    implementation: { description: 'ClinMesh read-only clinical projection', url: root }, rest: [{ mode: 'server', interaction: [{ code: 'history-system' }], resource: types.map(type => ({
      type, versioning: 'versioned', readHistory: true, interaction: interactions, searchParam: parameters(type).map(name => ({ name, type: name === '_id' ? 'token' : 'reference' })),
    })) }] };
}
function authorized(actor: Actor, type: ResourceType) {
  if (actor.role.capabilities.includes('workspace-admin')) return true;
  return type !== 'AuditEvent' && actor.role.capabilities.some(code => code === 'assess' || code === 'sign');
}
function respond(request: Request, reader: StoreReader, actor: Actor) {
  if (request.method !== 'GET') return failure(405, 'not-supported', 'FHIR accepts GET only.');
  const url = new URL(request.url);
  const root = `${url.origin}${base}`;
  const path = url.pathname.slice(base.length + 1).replace(/\/$/, '').split('/');
  const unsupported = () => failure(400, 'invalid', 'Unsupported search parameter or value.');
  if (path[0] === 'metadata' && path.length === 1) return url.search ? unsupported() : json(capability(root));
  const notFound = () => failure(404, 'not-found', 'Resource or version unavailable.');
  const systemHistory = path[0] === '_history' && path.length === 1;
  const type = resourceTypes.safeParse(path[0]).data;
  if (!systemHistory && !type) return notFound();
  if (type && !authorized(actor, type)) return failure(403, 'forbidden', 'Practitioner role lacks access.');
  const typeHistory = path.length === 2 && path[1] === '_history';
  const instanceHistory = path[2] === '_history';
  const history = systemHistory || typeHistory || instanceHistory;
  const search = path.length === 1 && !history;
  const id = !typeHistory && path[1];
  const version = path[3];
  if ((id && !fhirId.safeParse(id).success) || path.length > 4 || (path.length >= 3 && !instanceHistory) || (version && !/^[1-9]\d*$/.test(version))) return notFound();
  const filters = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!search || !type || !parameters(type).includes(key) || filters.has(key)) return unsupported();
    if (key === '_id' ? !fhirId.safeParse(value).success : (!referenceSearch.safeParse(value).success || (value.includes('/') && !value.startsWith(key === 'patient' ? 'Patient/' : 'Encounter/')))) return unsupported();
    filters.set(key, value.split('/').at(-1)!);
  }
  const rows = (type ? [type] : types.filter(item => authorized(actor, item))).flatMap(item => projectResources(reader, actor, item)).filter(row =>
    (!id || row.resource.id === id) && (!version || row.resource.meta.versionId === version) && (history || row.current) &&
    (!filters.has('_id') || filters.get('_id') === row.resource.id) && (!filters.has('patient') || filters.get('patient') === row.patient) && (!filters.has('encounter') || filters.get('encounter') === row.encounter));
  if (id && !rows.length) return notFound();
  if (id && (!history || version)) {
    const resource = rows[0]!.resource;
    return json(resource, 200, { etag: `W/"${resource.meta.versionId}"`, 'last-modified': new Date(resource.meta.lastUpdated).toUTCString() });
  }
  const entries = rows.sort((first, second) => Date.parse(second.resource.meta.lastUpdated) - Date.parse(first.resource.meta.lastUpdated) || Number(second.resource.meta.versionId) - Number(first.resource.meta.versionId)).map(({ resource }) => {
    const locator = `${resource.resourceType}/${resource.id}`;
    return { fullUrl: `${root}/${locator}`, resource, ...(history ? { request: { method: 'PUT', url: locator }, response: { status: resource.meta.versionId === '1' ? '201' : '200', etag: `W/"${resource.meta.versionId}"`, lastModified: resource.meta.lastUpdated } } : { search: { mode: 'match' } }) };
  });
  return json({ resourceType: 'Bundle', type: history ? 'history' : 'searchset', total: entries.length, link: [{ relation: 'self', url: url.href }], ...(entries.length && { entry: entries }) });
}
export const fhirModule: ClinMeshModule<OperationCatalog> = { id: 'mod-fhir-r5', kind: 'clinical', version: '1', projection: { base, respond } };
