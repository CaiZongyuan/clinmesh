import { z } from 'zod';

export const uuid = z.uuidv7().regex(/^[0-9a-f-]+$/);
const caseId = z.union([uuid, z.uuid({ version: 'v5' }).regex(/^[0-9a-f-]+$/)]);
export const instant = z.iso.datetime();
export const workspace = z.strictObject({ id: uuid, recorded_at: instant });
export type Workspace = z.infer<typeof workspace>;
export const scope = z.strictObject({ workspaceId: uuid, epoch: uuid });
export type StoreScope = z.infer<typeof scope>;
export const epoch = z.strictObject({
  status: z.enum(['building', 'active', 'closing', 'closed']), virtual_time: instant, clock_revision: z.int().nonnegative(),
});
export type WorkspaceEpoch = z.infer<typeof epoch>;

export interface Column<Value = unknown> {
  schema: z.ZodType<Value>;
  kind: 'text' | 'integer' | 'boolean' | 'json';
  nullable?: boolean;
  references?: string;
  check?: (name: string) => string;
}

const column = <Value>(schema: z.ZodType<Value>, kind: Column['kind'] = 'text', check?: Column['check']): Column<Value> => ({ schema, kind, check });
const id = column(uuid);
const text = column(z.string().min(1));
const timestamp = column(instant);
const integer = column(z.int(), 'integer');
const positive = column(z.int().positive(), 'integer', name => `${name} > 0`);
const boolean = column(z.boolean(), 'boolean', name => `${name} IN (0, 1)`);
const frozen = column(z.record(z.string(), z.json()), 'json');
const digest = column(z.string().regex(/^[0-9a-f]{64}$/));
const optional = <Value>(field: Column<Value>): Column<Value | null> => ({ ...field, nullable: true, schema: field.schema.nullable() });
const ref = (target: string): Column<string> => ({ ...id, schema: target === 'clinical_cases' ? caseId : uuid, references: target });
const choice = <const Values extends readonly [string, ...string[]]>(...values: Values) => column(z.enum(values), 'text', name => `${name} IN (${values.map(value => `'${value}'`).join(', ')})`);
const times = { virtual_at: timestamp, recorded_at: timestamp };
const version = positive;
const enc = ref('encounters');
const catalog = ref('catalog_items');
const order = ref('clinical_orders');
const admission = ref('inpatient_admissions');
const lot = ref('inventory_lots');
const currency = column(z.string().regex(/^[A-Z]{3}$/));
const exponent = column(z.int().min(0).max(9), 'integer', name => `${name} BETWEEN 0 AND 9`);
const money = { amount_minor: integer, currency_code: currency, currency_exponent: exponent };
const coding = { code_system: column(z.url()), code: text };
const encounterClass = choice('outpatient', 'inpatient');
const diagnosis = { ...coding, is_primary: boolean, poa_code: optional(text), ordinal: positive };
export const medicationRoute = z.enum(['PO', 'IVGTT', 'IV', 'IM', 'IH', 'SL', 'TOP', 'INH']);
export const signedDirections = z.strictObject({
  codeSystem: z.url(), code: z.string().min(1), display: z.strictObject({ en: z.string().min(1), zh: z.string().min(1) }),
  dose: z.number().positive(), doseUnit: z.string().min(1), routeCode: medicationRoute,
  timesPerDay: z.int().positive(), days: z.int().min(1).max(30), quantity: z.int().min(1).max(1000),
});

type Columns = Record<string, Column>;
export interface TableDefinition {
  fields: Columns;
  unique: string[];
  chain?: string;
}

function table<Fields extends Columns>(fields: Fields, ...unique: string[]) {
  return { fields: { id, ...fields }, unique };
}

function revisions<Fields extends Columns>(name: string, owner: string, fields: Fields) {
  return { ...table({ ...fields, revision: positive, previous_revision_id: optional(ref(name)), ...times }, `${owner}, revision`, `${owner}, id, revision`), chain: owner };
}

export const tables = {
  visitor_sessions: table({ practitioner_role: text, expires_at: timestamp, revoked: boolean, version }),
  capability_tokens: table({ token_hash: digest, practitioner_role: text, allowed_operations: column(z.array(z.string().min(1)), 'json'), expires_at: timestamp, revoked: boolean, version }, 'token_hash'),
  command_receipts: table({ idempotency_key: text, operation: text, request_hash: digest, result: column(z.json(), 'json'), recorded_at: timestamp }, 'idempotency_key'),
  audit_events: table({ actor: text, practitioner_role: text, operation: text, target_id: column(caseId), outcome: text, ...times }),
  data_pack_installations: table({ pack_id: text, pack_version: text, manifest: frozen, organization: frozen, knowledge: frozen, recorded_at: timestamp }, 'pack_id, pack_version'),
  catalog_items: table({ installation_id: ref('data_pack_installations'), kind: text, ...coding, definition: frozen, amount_minor: optional(integer), currency_code: optional(currency), currency_exponent: optional(exponent) }, 'kind, code_system, code'),
  clinical_cases: table({ id: column(caseId), installation_id: ref('data_pack_installations'), case_key: text, case_version: text, encounter_class: encounterClass, demographics: frozen, prior_history: frozen, triage_vitals: frozen }, 'installation_id, case_key, case_version'),
  case_personas: table({ case_id: ref('clinical_cases'), persona: frozen }, 'case_id'),
  case_truths: table({ case_id: ref('clinical_cases'), truth: frozen }, 'case_id'),
  patients: table({ display_name: text, birth_date: optional(column(z.iso.date())), version }),
  patient_identifiers: table({ patient_id: ref('patients'), issuer: text, value: text }, 'issuer, value'),
  encounters: table({ patient_id: ref('patients'), source_case_id: ref('clinical_cases'), encounter_class: encounterClass, status: text, active_practitioner_role: text, version, ...times }),
  pi_sessions: table({ agent: choice('patient', 'clinician'), encounter_id: optional(enc) }, 'encounter_id, agent'),
  consultations: table({ encounter_id: enc, reply_pending: boolean, version }, 'encounter_id'),
  consultation_turns: table({ consultation_id: ref('consultations'), ordinal: positive, speaker: choice('clinician', 'patient'), channel: choice('text', 'voice'), content: text, ...times }, 'consultation_id, ordinal'),
  clinical_record_drafts: table({ encounter_id: enc, fields: frozen, version }, 'encounter_id'),
  clinical_record_revisions: revisions('clinical_record_revisions', 'encounter_id', { encounter_id: enc, fields: frozen, signed_by: text }),
  diagnosis_drafts: table({ encounter_id: enc, ...diagnosis, version }, 'encounter_id, ordinal'),
  diagnosis_revisions: revisions('diagnosis_revisions', 'encounter_id', { encounter_id: enc, confirmed_by: text }),
  diagnosis_confirmations: table({ revision_id: ref('diagnosis_revisions'), ...diagnosis }, 'revision_id, ordinal'),
  clinical_orders: table({ encounter_id: enc, catalog_item_id: catalog, kind: choice('lab', 'examination', 'imaging', 'pathology', 'medication', 'nursing', 'surgery'), status: text, version, ...times }),
  diagnostic_reports: revisions('diagnostic_reports', 'order_id', { order_id: order, findings: frozen, signed_by: text }),
  report_acknowledgements: table({ report_id: ref('diagnostic_reports'), practitioner_role: text, ...times }, 'report_id'),
  clinical_overrides: table({ encounter_id: enc, rule_code: text, rationale: text, practitioner_role: text, ...times }),
  prescriptions: table({ encounter_id: enc, status: text, version, ...times }),
  prescription_orders: table({ prescription_id: ref('prescriptions'), order_id: order }, 'order_id'),
  no_medication_conclusions: table({ encounter_id: enc, reason: text, ...times }),
  inventory_lots: table({ catalog_item_id: catalog, lot_number: text, expiry_date: column(z.iso.date()), unit: text }, 'catalog_item_id, lot_number'),
  inventory_movements: table({ lot_id: lot, quantity_delta: column(z.int().refine(value => value !== 0), 'integer', name => `${name} <> 0`), reason: text, ...times }),
  dispenses: table({ prescription_order_id: ref('prescription_orders'), movement_id: ref('inventory_movements'), quantity: positive, ...times }, 'movement_id'),
  inpatient_admissions: table({ encounter_id: enc, ward: text, status: text, version, ...times }, 'encounter_id'),
  bed_occupancies: table({ admission_id: admission, bed: text, occupied_at: timestamp, released_at: optional(timestamp), version }),
  inpatient_transfers: table({ admission_id: admission, from_ward: text, to_ward: text, ...times }),
  order_executions: table({ order_id: order, practitioner_role: text, outcome: text, ...times }),
  surgery_requests: table({ order_id: order, procedure_item_id: catalog, status: text, version }, 'order_id'),
  surgery_executions: table({ surgery_request_id: ref('surgery_requests'), outcome: text, ...times }),
  material_reservations: table({ surgery_request_id: ref('surgery_requests'), lot_id: lot, quantity: positive, status: text, version }),
  material_uses: table({ reservation_id: ref('material_reservations'), movement_id: ref('inventory_movements'), quantity: positive, ...times }, 'movement_id'),
  medical_record_archives: table({ admission_id: admission, archive: frozen, ...times }, 'admission_id'),
  charge_items: table({ encounter_id: enc, order_id: optional(order), description: text, ...money, ...times }),
  charge_adjustments: table({ charge_id: ref('charge_items'), reason: text, ...money, ...times }),
  payment_transactions: table({ encounter_id: enc, ...money, ...times }),
  payment_tenders: table({ payment_id: ref('payment_transactions'), method: text, ...money }),
  payment_allocations: table({ tender_id: ref('payment_tenders'), charge_id: ref('charge_items'), ...money }),
  refund_transactions: table({ allocation_id: ref('payment_allocations'), reason: text, ...money, ...times }),
  regional_payer_records: table({ encounter_id: enc, payer_code: text, reference: text, determination: frozen, ...times }),
  encounter_triage: table({ encounter_id: enc, vitals: frozen, ...times }, 'encounter_id'),
  charge_sources: table({ charge_id: ref('charge_items'), order_id: order, catalog_item_id: catalog, catalog_version: text, quantity: positive, unit_price_minor: integer, department: optional(text), business_day: column(z.iso.date()) }, 'charge_id', 'order_id'),
  billing_previews: table({ encounter_id: enc, actor_id: id, practitioner_role: text, plan: frozen, fingerprint: digest, expires_at: timestamp, ...times }),
  billing_attempts: table({ payment_id: ref('payment_transactions'), preview_id: ref('billing_previews'), kind: choice('collection', 'refund', 'deposit', 'deposit-refund'), origin_id: optional(ref('payment_transactions')), initial_status: choice('succeeded', 'declined', 'unknown'), terminal_status: choice('succeeded', 'declined') }, 'payment_id', 'preview_id'),
  billing_recoveries: table({ payment_id: ref('payment_transactions'), status: choice('succeeded', 'declined'), ...times }, 'payment_id'),
  billing_releases: table({ charge_id: ref('charge_items'), ...times }, 'charge_id'),
  billing_settlements: table({ encounter_id: enc, preview_id: ref('billing_previews'), snapshot: frozen, ...times }, 'encounter_id', 'preview_id'),
  patient_reply_runs: table({ id: ref('consultation_turns'), session_id: ref('pi_sessions'), attempt: positive, status: choice('running', 'done', 'stopped', 'failed'), provider: text, model: text, endpoint_hash: digest, effort: text, error_code: optional(text), version }),
  agent_model_calls: table({ session_id: optional(ref('pi_sessions')), question_id: optional(ref('consultation_turns')), provider: text, model: text, status: text, input_tokens: integer, output_tokens: integer, cache_read: integer, cache_write: integer, duration_ms: integer, recorded_at: timestamp, version }),
  lab_drafts: table({ encounter_id: enc, items: column(z.array(frozen.schema), 'json'), version }, 'encounter_id'),
  lab_requests: table({ order_id: order, stages: column(z.array(z.enum(['follow-up', 'repeat', 'inpatient', 'initial'])).min(1), 'json') }, 'order_id'),
  prescription_signatures: table({ prescription_id: ref('prescriptions'), source: choice('internal', 'external'), actor: text, practitioner_role: text, catalog_version: text, snapshot_hash: digest }, 'prescription_id'),
  prescription_directions: table({ order_id: order, directions: column(signedDirections, 'json') }, 'order_id'),
  prescription_withdrawals: table({ prescription_id: ref('prescriptions'), actor: text, practitioner_role: text, reason: text, ...times }, 'prescription_id'),
  inventory_lot_quarantines: table({ id: lot, source_version: choice('clinmesh.snapshot.v1', 'clinmesh.snapshot.v2', 'clinmesh.snapshot.v3', 'clinmesh.snapshot.v4', 'clinmesh.snapshot.v5', 'sqlite.schema.v1', 'sqlite.schema.v2', 'sqlite.schema.v3', 'sqlite.schema.v4'), source_sha256: optional(digest), quantity_at_migration: column(z.int().negative(), 'integer', name => `${name} < 0`), ledger_fingerprint: column(z.uuid({ version: 'v5' })) }),
  ward_certificates: table({ source_encounter_id: enc, patient_id: ref('patients'), ward: text, reason: text, signed_by: text, ...times }),
  ward_referrals: table({ certificate_id: ref('ward_certificates'), admission_id: admission }, 'certificate_id', 'admission_id'),
  ward_transfer_tasks: table({ id: ref('inpatient_transfers'), status: choice('requested', 'handed-over', 'completed'), version }),
  ward_order_directions: table({ id: order, frequency: text, duration: choice('long', 'temporary'), directions: frozen, surgery_execution_id: optional(ref('surgery_executions')) }),
  ward_tasks: table({ order_id: order, business_day: column(z.iso.date()), slot: text, due_at: timestamp, status: choice('pending', 'dispensed', 'administered', 'completed', 'cancelled'), reason: optional(text), version }, 'order_id, business_day, slot'),
  ward_deliveries: table({ task_id: ref('ward_tasks'), movement_id: ref('inventory_movements'), quantity: positive, ...times }, 'movement_id'),
  ward_incurred_orders: table({ task_id: ref('ward_tasks'), order_id: order }, 'task_id', 'order_id'),
  ward_bed_days: table({ admission_id: admission, business_day: column(z.iso.date()), order_id: order }, 'admission_id, business_day', 'order_id'),
  ward_specimen_dispatches: table({ order_id: order, tube: text, sent_by: text, ...times }, 'order_id'),
  ward_surgery_plans: table({ id: ref('surgery_requests'), notice: frozen }),
  ward_surgery_preparations: table({ request_id: ref('surgery_requests'), kind: choice('nursing', 'consent'), document: frozen, signed_by: text, ...times }, 'request_id, kind'),
  ward_surgery_stages: table({ request_id: ref('surgery_requests'), stage: choice('planned', 'ad-hoc-pci'), order_id: order, parent_execution_id: optional(ref('surgery_executions')), completed_execution_id: optional(ref('surgery_executions')), version }, 'request_id, stage', 'order_id'),
  ward_surgery_supplies: table({ stage_id: ref('ward_surgery_stages'), reservation_id: ref('material_reservations'), planned: boolean }, 'reservation_id'),
  ward_material_corrections: table({ use_id: ref('material_uses'), quantity: positive, movement_id: ref('inventory_movements'), reason: text, ...times }, 'movement_id'),
  ward_surgery_charges: table({ stage_id: ref('ward_surgery_stages'), order_id: order, purpose: choice('medication', 'nursing', 'report') }, 'order_id'),
  ward_chart_revisions: revisions('ward_chart_revisions', 'admission_id', { admission_id: admission, front_page: frozen, submitted_by: text }),
  ward_coding_reviews: table({ revision_id: ref('ward_chart_revisions'), reviewed_by: text, coding: frozen, ...times }, 'revision_id'),
} satisfies Record<string, TableDefinition>;

export type Entity = keyof typeof tables;
export type EntityRow<Name extends Entity> = { [Key in keyof (typeof tables)[Name]['fields']]: (typeof tables)[Name]['fields'][Key] extends Column<infer Value> ? Value : never };
export type PublicEntity = Exclude<Entity, 'case_truths'>;
export const entityNames = Object.keys(tables) as Entity[];
export const billingEntities = ['charge_sources', 'billing_previews', 'billing_attempts', 'billing_recoveries', 'billing_releases', 'billing_settlements'] as const satisfies readonly Entity[];
export const pharmacyEntities = ['prescription_signatures', 'prescription_directions', 'prescription_withdrawals', 'inventory_lot_quarantines'] as const satisfies readonly Entity[];
export const labEntities = ['lab_drafts', 'lab_requests'] as const satisfies readonly Entity[];
export const wardEntities = ['ward_certificates', 'ward_referrals', 'ward_transfer_tasks', 'ward_order_directions', 'ward_tasks', 'ward_deliveries', 'ward_incurred_orders', 'ward_bed_days', 'ward_specimen_dispatches', 'ward_surgery_plans', 'ward_surgery_preparations', 'ward_surgery_stages', 'ward_surgery_supplies', 'ward_material_corrections', 'ward_surgery_charges', 'ward_chart_revisions', 'ward_coding_reviews'] as const satisfies readonly Entity[];

export const editable = {
  patients: ['display_name', 'birth_date'], encounters: ['active_practitioner_role', 'status'], consultations: ['reply_pending'],
  clinical_record_drafts: ['fields'], diagnosis_drafts: ['code', 'code_system', 'is_primary', 'poa_code', 'ordinal'],
  visitor_sessions: ['practitioner_role', 'revoked'], capability_tokens: ['revoked'], clinical_orders: ['status'],
  prescriptions: ['status'], inpatient_admissions: ['status', 'ward'], bed_occupancies: ['released_at'],
  surgery_requests: ['status'], material_reservations: ['status'],
  lab_drafts: ['items'],
  ward_transfer_tasks: ['status'], ward_tasks: ['status'], ward_surgery_stages: ['completed_execution_id'],
  patient_reply_runs: ['attempt', 'status', 'provider', 'model', 'endpoint_hash', 'effort', 'error_code'],
  agent_model_calls: ['status', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'duration_ms'],
} as const satisfies { [Name in Entity]?: readonly (keyof EntityRow<Name>)[] };
export type EditableEntity = keyof typeof editable;
export type Changes<Name extends EditableEntity> = Partial<Pick<EntityRow<Name>, (typeof editable)[Name][number] & keyof EntityRow<Name>>>;

const isolation = 'workspace_id, epoch';
const epochReference = `FOREIGN KEY (${isolation}) REFERENCES workspace_epochs (${isolation}) ON DELETE RESTRICT`;

function createTable(name: Entity, { fields, unique, chain }: TableDefinition): string {
  const columns = ['workspace_id TEXT NOT NULL', 'epoch TEXT NOT NULL'];
  const constraints = [`PRIMARY KEY (${isolation}, id)`, epochReference, ...unique.map(keys => `UNIQUE (${isolation}, ${keys})`)];
  for (const [key, field] of Object.entries(fields)) {
    const type = field.kind === 'integer' || field.kind === 'boolean' ? 'INTEGER' : 'TEXT';
    columns.push(`${key} ${type}${field.nullable ? '' : ' NOT NULL'}${field.check ? ` CHECK (${field.check(key)})` : ''}`);
    if (field.references) constraints.push(`FOREIGN KEY (${isolation}, ${key}) REFERENCES ${field.references} (${isolation}, id) ON DELETE RESTRICT`);
  }
  if (chain) {
    columns.push('previous_revision INTEGER');
    constraints.push('CHECK ((revision = 1 AND previous_revision_id IS NULL AND previous_revision IS NULL) OR (revision > 1 AND previous_revision_id IS NOT NULL AND previous_revision IS NOT NULL AND previous_revision = revision - 1))',
      `FOREIGN KEY (${isolation}, ${chain}, previous_revision_id, previous_revision) REFERENCES ${name} (${isolation}, ${chain}, id, revision) ON DELETE RESTRICT`);
  }
  if (name === 'catalog_items') constraints.push('CHECK ((amount_minor IS NULL AND currency_code IS NULL AND currency_exponent IS NULL) OR (amount_minor IS NOT NULL AND currency_code IS NOT NULL AND currency_exponent IS NOT NULL))');
  if (name === 'pi_sessions') constraints.push("CHECK (agent <> 'patient' OR encounter_id IS NOT NULL)");
  return `CREATE TABLE IF NOT EXISTS ${name} (${[...columns, ...constraints].join(', ')})`;
}

export function initializeSchema(exec: (sql: string) => void): void {
  exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT NOT NULL PRIMARY KEY, recorded_at TEXT NOT NULL)');
  exec(`CREATE TABLE IF NOT EXISTS workspace_epochs (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, epoch TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('building','active','closing','closed')), virtual_time TEXT NOT NULL, clock_revision INTEGER NOT NULL CHECK (clock_revision >= 0), PRIMARY KEY (${isolation}))`);
  exec("CREATE UNIQUE INDEX IF NOT EXISTS one_active_epoch ON workspace_epochs (workspace_id) WHERE status = 'active'");
  for (const name of entityNames) {
    initializeEntity(exec, name);
  }
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_primary_diagnosis ON diagnosis_confirmations (${isolation}, revision_id) WHERE is_primary = 1`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_occupied_bed ON bed_occupancies (${isolation}, bed) WHERE released_at IS NULL`);
  initializeWardIndexes(exec);
}

export function initializeWardIndexes(exec: (sql: string) => void) {
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_bed_per_admission ON bed_occupancies (${isolation}, admission_id) WHERE released_at IS NULL`);
}

export function initializeEntity(exec: (sql: string) => void, name: Entity) {
  exec(createTable(name, tables[name]));
  if (!Object.hasOwn(editable, name)) for (const action of ['UPDATE', 'DELETE']) {
    exec(`CREATE TRIGGER IF NOT EXISTS immutable_${name}_${action} BEFORE ${action} ON ${name} BEGIN SELECT RAISE(ABORT, 'Immutable fact'); END`);
  }
}
