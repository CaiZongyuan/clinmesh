import { createHash } from 'node:crypto'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import type {
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { z } from 'zod'
import type {
  ActorContext,
  CommandResponse,
  CommandTransaction,
} from './command-executor.ts'
import { CommandExecutor } from './command-executor.ts'
import { syntheticAccounts } from './identity-service.ts'
import { createHospitalBaseline } from './scenario-data/hospital-baseline.ts'

const clinicalReviewSchema = z.record(z.string(), z.unknown())
const countRowSchema = z.object({ count: z.number().int().nonnegative() }).strict()

type HospitalBaseline = ReturnType<typeof createHospitalBaseline>

function installedMedicationConfigJson(
  medication: HospitalBaseline['catalog']['medications'][number],
  diagnosisIdByCode: ReadonlyMap<string, string>,
  allowedCombinationIds = medication.workflow.allowedCombinationIds,
) {
  return JSON.stringify({
    allowedCombinationIds,
    allowedCourseDays: medication.workflow.allowedCourseDays,
    allowedDiagnosisCatalogItemIds: medication.workflow.allowedDiagnosisCodes.flatMap((code) => {
      const diagnosisId = diagnosisIdByCode.get(code)
      return diagnosisId === undefined ? [] : [diagnosisId]
    }),
    allowedDoseTexts: medication.workflow.allowedDoseTexts,
    allowedFrequencyCodes: medication.workflow.allowedFrequencyCodes,
    allowedQuantities: medication.workflow.allowedQuantities,
    defaultCourseDays: medication.workflow.defaultCourseDays,
    defaultQuantity: medication.workflow.defaultQuantity,
    dose: medication.defaultDose,
    frequency: medication.defaultFrequency,
    ...('product' in medication
      ? {
          availableScopes: medication.availableScopes,
          drugConcept: medication.drugConcept,
          product: medication.product,
          regulatoryVerification: medication.regulatoryVerification,
        }
      : {}),
  })
}

function installedDiagnosisCatalogRow(
  diagnosis: HospitalBaseline['catalog']['diagnoses'][number],
) {
  return [
    diagnosis.id,
    diagnosis.codeSystem,
    diagnosis.code,
    diagnosis.name,
    diagnosis.name,
  ] as const
}

function installedServiceConfigJson(
  service: HospitalBaseline['catalog']['services'][number],
) {
  return JSON.stringify({
    availableScopes: service.availableScopes,
    billingUnit: service.billingUnit,
    category: service.category,
    chargeDefinition: service.chargeDefinition,
    componentServiceIds: service.componentServiceIds,
    executingDepartmentId: service.executingDepartmentId,
    nationalService: service.nationalService,
    reportTemplate: service.reportTemplate,
    requestCatalogItemIds: service.requestCatalogItemIds,
    tatMinutes: service.tatMinutes,
  })
}

const laboratoryResultsHiddenFact = {
  code: 'laboratory-results',
  value: {
    'lab-cbc': {
      conclusion: '白细胞计数升高，其余血常规指标在参考范围内。',
      results: [{
        code: '6690-2',
        display: '白细胞计数',
        interpretation: 'high',
        referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5 x10^9/L' },
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
        value: 11.2,
      }, {
        code: '718-7',
        display: '血红蛋白',
        interpretation: 'normal',
        referenceRange: { high: 150, low: 115, text: '115-150 g/L' },
        unit: { code: 'g/L', display: 'g/L', system: 'http://unitsofmeasure.org' },
        value: 135,
      }, {
        code: '777-3',
        display: '血小板计数',
        interpretation: 'normal',
        referenceRange: { high: 350, low: 125, text: '125-350 x10^9/L' },
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
        value: 210,
      }],
    },
    'lab-crp': {
      conclusion: 'C 反应蛋白升高。',
      results: [{
        code: '1988-5',
        display: 'C 反应蛋白',
        interpretation: 'high',
        referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
        value: 18.6,
      }],
    },
  },
} as const


const legacyScenarioBlueprints = {
  candidate: {
    clinicalReview: null,
    hiddenFacts: [{
      code: 'respiratory-pathogen',
      value: { code: 'influenza-a', detected: true },
    }],
    kind: 'candidate',
    revealPolicies: [{
      code: 'paid-lis-report',
      factCode: 'respiratory-pathogen',
      triggerCode: 'lis-report-final',
    }],
    schemaVersion: '1',
    seed: 20260824,
    simulatorRules: [
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'decline', outcome: 'declined', simulator: 'payment' },
      { code: 'ambiguous', outcome: 'ambiguous', simulator: 'payment' },
      { code: 'deterministic-report', outcome: 'success', simulator: 'lis' },
    ],
    scenarioId: 'candidate-fever-outpatient-v1',
    version: '1.0.0',
    virtualTime: '2026-08-24T09:00:00+08:00',
  },
  density: {
    clinicalReview: null,
    hiddenFacts: [{
      code: 'respiratory-pathogen',
      value: { code: 'influenza-a', detected: true },
    }],
    kind: 'density',
    revealPolicies: [{
      code: 'paid-lis-report',
      factCode: 'respiratory-pathogen',
      triggerCode: 'lis-report-final',
    }],
    schemaVersion: '1',
    seed: 20260825,
    simulatorRules: [
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'deterministic-report', outcome: 'success', simulator: 'lis' },
    ],
    scenarioId: 'density-fever-outpatient-v1',
    version: '1.0.0',
    virtualTime: '2026-08-24T09:00:00+08:00',
  },
} as const

const versionTwoScenarioBlueprints = {
  candidate: {
    ...legacyScenarioBlueprints.candidate,
    hiddenFacts: [
      ...legacyScenarioBlueprints.candidate.hiddenFacts,
      laboratoryResultsHiddenFact,
    ],
    scenarioId: 'candidate-fever-outpatient-v2',
    schemaVersion: '2',
    version: '2.0.0',
  },
  density: {
    ...legacyScenarioBlueprints.density,
    hiddenFacts: [
      ...legacyScenarioBlueprints.density.hiddenFacts,
      laboratoryResultsHiddenFact,
    ],
    scenarioId: 'density-fever-outpatient-v2',
    schemaVersion: '2',
    version: '2.0.0',
  },
} as const

const installableScenarioBlueprints = {
  candidate: {
    ...versionTwoScenarioBlueprints.candidate,
    medicationRulesVersion: 'prescription-conclusion-v1',
    scenarioId: 'candidate-fever-outpatient-v3',
    schemaVersion: '3',
    version: '3.0.0',
  },
  density: {
    ...versionTwoScenarioBlueprints.density,
    medicationRulesVersion: 'prescription-conclusion-v1',
    scenarioId: 'density-fever-outpatient-v3',
    schemaVersion: '3',
    version: '3.0.0',
  },
} as const

const knownScenarioBlueprints = [
  ...Object.values(legacyScenarioBlueprints),
  ...Object.values(versionTwoScenarioBlueprints),
  ...Object.values(installableScenarioBlueprints),
] as const

interface ScenarioBlueprint {
  clinicalReview: null | Record<string, unknown>
  hiddenFacts: ReadonlyArray<{ code: string; patientId?: string; value: unknown }>
  kind: 'candidate' | 'density' | 'golden'
  medicationRulesVersion?: string
  revealPolicies: ReadonlyArray<{
    code: string
    factCode: string
    patientId?: string
    triggerCode: string
    triggerId?: string
  }>
  scenarioId: string
  schemaVersion: string
  seed: number
  simulatorRules: ReadonlyArray<{ code: string; outcome: string; simulator: string }>
  version: string
  virtualTime: string
}

export interface ScenarioState {
  clinicalReview: null | Record<string, unknown>
  epoch: string
  initialStateHash: string
  kind: 'candidate' | 'density' | 'golden'
  scenarioId: string
  scenarioRunId: string
  seed: number
  status: 'active' | 'closed' | 'completed'
  virtualTime: string
  workspaceId: string
}

interface ScenarioStateRow {
  clinical_review_json: string | null
  epoch: string
  initial_state_hash: string
  kind: ScenarioState['kind']
  scenario_id: string
  scenario_run_id: string
  seed: number
  status: ScenarioState['status']
  virtual_time: string
  workspace_id: string
}

export class ScenarioError extends Error {
  readonly code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING' | 'SCENARIO_GENERATION_RUNNING'
  readonly status: 403 | 404 | 409

  constructor(
    code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING' | 'SCENARIO_GENERATION_RUNNING',
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'SCENARIO_STATE_MISSING' ? 404 : 409
  }
}

function blueprintHash(blueprint: ScenarioBlueprint): string {
  return createHash('sha256').update(JSON.stringify(blueprint)).digest('hex')
}

interface ReplaySyntheticCasesInput {
  fromContext: ActorContext
  toContext: ActorContext
  transaction: CommandTransaction
}

export class ScenarioService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #hospitalBaseline: ReturnType<typeof createHospitalBaseline>
  readonly #replaySyntheticCases: ((input: ReplaySyntheticCasesInput) => void) | undefined

  constructor(
    database: ClinMeshDatabase,
    fhir: FhirRepository,
    commands: CommandExecutor,
    medicationProducts: readonly ReferenceMedicationProduct[],
    medicalServices: readonly ReferenceMedicalService[],
    valueSetEntries: readonly ReferenceValueSetEntry[],
    options: { replaySyntheticCases?: (input: ReplaySyntheticCasesInput) => void } = {},
  ) {
    this.#commands = commands
    this.#database = database
    this.#fhir = fhir
    this.#hospitalBaseline = createHospitalBaseline(
      medicationProducts,
      medicalServices,
      valueSetEntries,
    )
    this.#replaySyntheticCases = options.replaySyntheticCases
  }

  ensureInitialEpoch(input: {
    epoch: string
    scenarioRunId: string
    workspaceId: string
  }): void {
    this.#installDefinitions()
    const existing = this.#database.driver.prepare(`
      SELECT 1 AS present
      FROM scenario_epoch_state
      WHERE workspace_id = ? AND epoch = ?
    `).get(input.workspaceId, input.epoch)
    if (existing !== undefined) return
    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      this.#seedEpoch({
        blueprint: installableScenarioBlueprints.candidate,
        epoch: input.epoch,
        scenarioRunId: input.scenarioRunId,
        workspaceId: input.workspaceId,
      })
      this.#database.driver.exec('COMMIT')
    } catch (error) {
      this.#database.driver.exec('ROLLBACK')
      throw error
    }
  }

  current(context: ActorContext): ScenarioState {
    const row = this.#database.driver.prepare(`
      SELECT
        state.workspace_id,
        state.epoch,
        state.scenario_run_id,
        state.scenario_id,
        definition.kind,
        definition.clinical_review_json,
        state.deterministic_seed AS seed,
        state.virtual_time,
        state.initial_state_hash,
        run.status
      FROM workspace
      JOIN scenario_epoch_state AS state
        ON state.workspace_id = workspace.workspace_id
       AND state.epoch = workspace.active_epoch
      JOIN scenario_definition AS definition
        ON definition.scenario_id = state.scenario_id
      JOIN scenario_run AS run
        ON run.workspace_id = state.workspace_id
       AND run.epoch = state.epoch
       AND run.scenario_run_id = state.scenario_run_id
      WHERE workspace.workspace_id = ?
        AND workspace.active_epoch = ?
        AND state.scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as ScenarioStateRow | undefined
    if (row === undefined) {
      throw new ScenarioError('SCENARIO_STATE_MISSING', 'The active Scenario state was not found')
    }
    return this.#mapState(row)
  }

  reset(input: {
    clearPatientLibrary?: boolean
    context: ActorContext
    idempotencyKey: string
    scenarioRunId: string
  }): CommandResponse<ScenarioState> {
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioStateSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { scenarioRunId: input.scenarioRunId, ...(input.clearPatientLibrary === true ? { clearPatientLibrary: true } : {}) },
      operation: 'scenario.reset',
    }, (transaction) => {
      if (input.context.roleCode !== 'administrator') {
        throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can reset a Scenario Run')
      }
      if (input.scenarioRunId !== input.context.scenarioRunId) {
        throw new ScenarioError('SCENARIO_RUN_CONFLICT', 'The Scenario Run is no longer active')
      }
      if (input.clearPatientLibrary === true) {
        const running = this.#database.driver.prepare(`
          SELECT 1 FROM scenario_generation_job WHERE workspace_id = ? AND status = 'running'
          UNION ALL SELECT 1 FROM patient_persona_job WHERE workspace_id = ? AND status = 'running'
          LIMIT 1
        `).get(input.context.workspaceId, input.context.workspaceId)
        if (running !== undefined) throw new ScenarioError('SCENARIO_GENERATION_RUNNING', '患者或梗概正在生成，请等待完成后再清空患者库。')
      }
      const currentState = this.current(input.context)
      const blueprint = knownScenarioBlueprints.find(
        candidate => candidate.scenarioId === currentState.scenarioId,
      ) ?? installableScenarioBlueprints.candidate
      const transition = this.#transitionEpoch(input.context, blueprint)
      // The reset audit belongs to the closing Epoch; replayed FHIR facts belong to the new Epoch.
      if (input.clearPatientLibrary === true) {
        const now = new Date().toISOString()
        this.#database.driver.prepare(`
          UPDATE synthetic_patient_profile SET archived_at = ?
          WHERE workspace_id = ? AND archived_at IS NULL
        `).run(now, input.context.workspaceId)
        this.#database.driver.prepare(`
          UPDATE synthetic_case_instance SET status = 'retired', revision = revision + 1, updated_at = ?
          WHERE workspace_id = ? AND status != 'retired'
        `).run(now, input.context.workspaceId)
        for (const table of ['scenario_generation_job', 'patient_persona_job']) {
          this.#database.driver.prepare(`
            UPDATE ${table} SET status = 'failed', error_code = 'SCENARIO_DATA_RESET',
              error_message = '患者库已清空，生成任务已取消。', started_at = ?, finished_at = ?, updated_at = ?
            WHERE workspace_id = ? AND status = 'queued'
          `).run(now, now, now, input.context.workspaceId)
        }
      } else this.#replaySyntheticCases?.({
        fromContext: input.context,
        toContext: {
          ...input.context,
          epoch: transition.data.epoch,
          scenarioRunId: transition.data.scenarioRunId,
        },
        transaction,
      })
      return transition
    })
  }

  install(input: {
    context: ActorContext
    idempotencyKey: string
    kind: keyof typeof installableScenarioBlueprints
  }): CommandResponse<ScenarioState> {
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioStateSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { kind: input.kind },
      operation: 'scenario.install',
    }, () => {
      if (input.context.roleCode !== 'administrator') {
        throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can install a Scenario')
      }
      return this.#transitionEpoch(input.context, installableScenarioBlueprints[input.kind])
    })
  }

  #transitionEpoch(context: ActorContext, blueprint: ScenarioBlueprint) {
    const sequence = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM workspace_epoch WHERE workspace_id = ?
    `).get(context.workspaceId)).count + 1
    const epoch = `epoch-${sequence}`
    const scenarioRunId = `scenario-run-${sequence}`
    const now = new Date().toISOString()
    this.#database.driver.prepare(`
      INSERT INTO workspace_epoch (
        workspace_id, epoch, state, scenario_id, created_at, activated_at
      ) VALUES (?, ?, 'building', ?, ?, ?)
    `).run(context.workspaceId, epoch, blueprint.scenarioId, now, now)
    this.#database.driver.prepare(`
      INSERT INTO scenario_run (
        workspace_id, epoch, scenario_run_id, scenario_id, status, started_at
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(context.workspaceId, epoch, scenarioRunId, blueprint.scenarioId, now)
    this.#database.driver.prepare(`
      INSERT INTO audit_head (workspace_id, epoch, sequence, hash)
      VALUES (?, ?, 0, ?)
    `).run(context.workspaceId, epoch, '0'.repeat(64))
    this.#seedEpoch({
      blueprint,
      epoch,
      scenarioRunId,
      workspaceId: context.workspaceId,
    })
    this.#database.driver.prepare(`
      INSERT OR REPLACE INTO hospital_service_catalog (
        workspace_id, epoch, service_id, code, name_zh, name_en,
        version, active, config_json
      )
      SELECT workspace_id, ?, service_id, code, name_zh, name_en,
        version, active, config_json
      FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND json_type(config_json, '$.laboratoryService') = 'object'
    `).run(epoch, context.workspaceId, context.epoch)
    this.#database.driver.prepare(`
      UPDATE outbox_event
      SET status = 'abandoned', lease_owner = NULL, leased_until = NULL, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND status IN ('queued', 'claimed')
    `).run(now, context.workspaceId, context.epoch)
    this.#database.driver.prepare(`
      UPDATE scenario_run
      SET status = 'closed', completed_at = ?
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
        AND status = 'active'
    `).run(now, context.workspaceId, context.epoch, context.scenarioRunId)
    this.#database.driver.prepare(`
      UPDATE workspace_epoch
      SET state = 'closed', closed_at = ?
      WHERE workspace_id = ? AND epoch = ?
    `).run(now, context.workspaceId, context.epoch)
    this.#database.driver.prepare(`
      UPDATE workspace_epoch SET state = 'active' WHERE workspace_id = ? AND epoch = ?
    `).run(context.workspaceId, epoch)
    this.#database.driver.prepare(`
      UPDATE workspace SET active_epoch = ? WHERE workspace_id = ?
    `).run(epoch, context.workspaceId)
    const state: ScenarioState = {
      clinicalReview: blueprint.clinicalReview,
      epoch,
      initialStateHash: blueprintHash(blueprint),
      kind: blueprint.kind,
      scenarioId: blueprint.scenarioId,
      scenarioRunId,
      seed: blueprint.seed,
      status: 'active',
      virtualTime: blueprint.virtualTime,
      workspaceId: context.workspaceId,
    }
    return {
      data: state,
      effects: [{
        kind: 'created' as const,
        reference: `ScenarioRun/${scenarioRunId}`,
        versionId: '1',
      }],
    }
  }

  #installDefinitions(): void {
    const insert = this.#database.driver.prepare(`
      INSERT OR IGNORE INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const blueprint of knownScenarioBlueprints) {
      insert.run(
        blueprint.scenarioId,
        blueprint.version,
        blueprint.kind,
        blueprint.schemaVersion,
        blueprint.clinicalReview === null ? null : JSON.stringify(blueprint.clinicalReview),
      )
    }
  }

  #mapState(row: ScenarioStateRow): ScenarioState {
    return {
      clinicalReview: row.clinical_review_json === null
        ? null
        : clinicalReviewSchema.parse(JSON.parse(row.clinical_review_json)),
      epoch: row.epoch,
      initialStateHash: row.initial_state_hash,
      kind: row.kind,
      scenarioId: row.scenario_id,
      scenarioRunId: row.scenario_run_id,
      seed: row.seed,
      status: row.status,
      virtualTime: row.virtual_time,
      workspaceId: row.workspace_id,
    }
  }

  #seedEpoch(input: {
    blueprint: ScenarioBlueprint
    epoch: string
    scenarioRunId: string
    workspaceId: string
  }): void {
    const { blueprint } = input
    this.#database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id, deterministic_seed,
        virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.epoch,
      input.scenarioRunId,
      blueprint.scenarioId,
      blueprint.seed,
      blueprint.virtualTime,
      blueprintHash(blueprint),
    )
    const insertFact = this.#database.driver.prepare(`
      INSERT INTO scenario_hidden_fact (
        workspace_id, epoch, fact_code, value_json
      ) VALUES (?, ?, ?, ?)
    `)
    for (const fact of blueprint.hiddenFacts) {
      insertFact.run(input.workspaceId, input.epoch, fact.code, JSON.stringify(fact.value))
    }
    const insertPolicy = this.#database.driver.prepare(`
      INSERT INTO scenario_reveal_policy (
        workspace_id, epoch, policy_code, trigger_code, fact_code
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const policy of blueprint.revealPolicies) {
      insertPolicy.run(
        input.workspaceId,
        input.epoch,
        policy.code,
        policy.triggerCode,
        policy.factCode,
      )
    }
    const insertRule = this.#database.driver.prepare(`
      INSERT INTO scenario_simulator_rule (
        workspace_id, epoch, simulator, rule_code, outcome, config_json
      ) VALUES (?, ?, ?, ?, ?, '{}')
    `)
    for (const rule of blueprint.simulatorRules) {
      insertRule.run(input.workspaceId, input.epoch, rule.simulator, rule.code, rule.outcome)
    }
    const insertCatalog = this.#database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `)
    const supportsPrescriptionConclusion = blueprint.medicationRulesVersion === 'prescription-conclusion-v1'
    const hospitalBaseline = this.#hospitalBaseline
    const hospitalDiagnosisIdByCode = new Map(
      hospitalBaseline.catalog.diagnoses.map(diagnosis => [diagnosis.code, diagnosis.id]),
    )
    const hospitalAcetaminophen = hospitalBaseline.catalog.medications.find(
      medication => medication.id === 'medication-acetaminophen',
    )
    if (hospitalAcetaminophen === undefined) {
      throw new Error('The Hospital Baseline is missing medication-acetaminophen')
    }
    const legacyDepartmentCatalog = [
      'department-general-medicine', 'department', 'GM', '全科医学科', 'General Medicine', 0, '{}',
    ] as const
    const legacyVisitCatalog = [
      'visit-general', 'visit-type', 'GENERAL', '普通门诊挂号费',
      'General outpatient registration', 2000, '{}',
    ] as const
    const legacyCatalog = [
      legacyDepartmentCatalog,
      ...(supportsPrescriptionConclusion
        ? hospitalBaseline.catalog.departments
            .filter(department => department.id !== 'department-general-medicine')
            .map(department => [
              department.id,
              'department',
              department.code,
              department.name,
              department.name,
              department.priceFen,
              JSON.stringify({ registrationAvailable: department.registrationAvailable ?? true }),
            ] as const)
        : []),
      legacyVisitCatalog,
      ['lab-fever-panel', 'laboratory', 'FEVER-PANEL', '发热检验组合', 'Fever laboratory panel', 6800, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['lab-cbc', 'laboratory', 'CBC', '血常规', 'Complete blood count', 2500, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['lab-crp', 'laboratory', 'CRP', 'C 反应蛋白', 'C-reactive protein', 4300, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['medication-oseltamivir', 'medication', 'OSELTAMIVIR', '磷酸奥司他韦胶囊', 'Oseltamivir phosphate capsules', 760, supportsPrescriptionConclusion
        ? '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"],"allowedCourseDays":[5],"allowedDiagnosisCatalogItemIds":["diagnosis-influenza"],"allowedQuantities":[10],"defaultCourseDays":5,"defaultQuantity":10}'
        : '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"]}'],
      ['medication-acetaminophen', 'medication', 'ACETAMINOPHEN', '对乙酰氨基酚片', 'Acetaminophen tablets', 120, supportsPrescriptionConclusion
        ? installedMedicationConfigJson(
            hospitalAcetaminophen,
            hospitalDiagnosisIdByCode,
            ['medication-oseltamivir'],
          )
        : '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"]}'],
      ...(supportsPrescriptionConclusion
        ? hospitalBaseline.catalog.medications
            .filter(medication => medication.id !== 'medication-acetaminophen')
            .map(medication => [
              medication.id,
              'medication',
              medication.code,
              medication.name,
              medication.name,
              medication.priceFen,
              installedMedicationConfigJson(medication, hospitalDiagnosisIdByCode),
            ] as const)
        : []),
    ] as const
    const installedCatalog = new Map(legacyCatalog.map(item => [item[0], item])).values()
    for (const item of installedCatalog) {
      insertCatalog.run(input.workspaceId, input.epoch, ...item)
    }
    const insertService = this.#database.driver.prepare(`
      INSERT INTO hospital_service_catalog (
        workspace_id, epoch, service_id, code, name_zh, name_en,
        version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    `)
    const installedServices = supportsPrescriptionConclusion ? hospitalBaseline.catalog.services : []
    for (const service of installedServices) {
      insertService.run(
        input.workspaceId,
        input.epoch,
        service.id,
        service.code,
        service.name,
        service.name,
        installedServiceConfigJson(service),
      )
    }
    const insertDiagnosisCatalog = this.#database.driver.prepare(`
      INSERT INTO diagnosis_catalog (
        workspace_id, epoch, item_id, code_system, code, name_zh, name_en,
        version, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
    `)
    const legacyDiagnosisCatalog = [
      [
        'diagnosis-influenza',
        'http://hl7.org/fhir/sid/icd-10',
        'J10.1',
        '流感伴其他呼吸道表现，季节性流感病毒已标明',
        'Influenza with other respiratory manifestations, seasonal influenza virus identified',
      ],
      [
        'diagnosis-acute-upper-respiratory-infection',
        'http://hl7.org/fhir/sid/icd-10',
        'J06.9',
        '急性上呼吸道感染，未特指',
        'Acute upper respiratory infection, unspecified',
      ],
      ['diagnosis-fever', 'http://hl7.org/fhir/sid/icd-10', 'R50.9', '发热，未特指', 'Fever, unspecified'],
      ...(supportsPrescriptionConclusion
        ? hospitalBaseline.catalog.diagnoses
            .filter(diagnosis => ![
              'diagnosis-acute-upper-respiratory-infection',
              'diagnosis-fever',
              'diagnosis-influenza',
            ].includes(diagnosis.id))
            .map(installedDiagnosisCatalogRow)
        : []),
    ] as const
    for (const diagnosis of legacyDiagnosisCatalog) {
      insertDiagnosisCatalog.run(input.workspaceId, input.epoch, ...diagnosis)
    }
    const insertLot = this.#database.driver.prepare(`
      INSERT INTO inventory_lot (
        workspace_id, epoch, lot_id, medication_id, location_id,
        lot_number, expires_on, quantity_on_hand, version
      ) VALUES (?, ?, ?, ?, 'location-pharmacist', ?, ?, ?, 1)
    `)
    const inventory = [{
      expiresOn: '2027-12-31',
      itemId: 'medication-oseltamivir',
      lotId: 'lot-oseltamivir-202608',
      lotNumber: 'SYN-OSE-202608',
      quantity: 1_000,
    }, {
      expiresOn: '2027-12-31',
      itemId: 'medication-acetaminophen',
      lotId: 'lot-acetaminophen-202608',
      lotNumber: 'SYN-ACE-202608',
      quantity: 1_000,
    }, ...(supportsPrescriptionConclusion
      ? hospitalBaseline.inventory
          .filter(lot => lot.itemId !== 'medication-acetaminophen')
          .map(lot => ({ ...lot, lotNumber: lot.lotId }))
      : [])]
    for (const lot of inventory) {
      insertLot.run(
        input.workspaceId,
        input.epoch,
        lot.lotId,
        lot.itemId,
        lot.lotNumber,
        lot.expiresOn,
        lot.quantity,
      )
    }
    this.#seedFhirResources(input)
  }

  #seedFhirResources(input: {
    blueprint: ScenarioBlueprint
    epoch: string
    workspaceId: string
  }): void {
    const context = { epoch: input.epoch, workspaceId: input.workspaceId }
    const hospitalBaseline = this.#hospitalBaseline
    this.#fhir.create(context, {
      resourceType: 'Organization',
      id: 'organization-clinmesh',
      active: true,
      identifier: [{
        system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-organization',
        value: 'CM-SYN-HOSPITAL-001',
      }],
      name: '安康市临床仿真医院',
      alias: ['Ankang Clinical Simulation Hospital'],
    })
    const locations: Array<readonly [string, string, string]> = [
      ['location-outpatient', '门诊诊疗区', 'Outpatient clinic'] as const,
      ['location-laboratory', '合成检验科', 'Synthetic laboratory'] as const,
      ...syntheticAccounts.map(account => [
        `location-${account.roleCode}`,
        `${account.name}工作区`,
        `${account.roleCode} workspace`,
      ] as const),
    ]
    for (const [id, nameZh, nameEn] of locations) {
      this.#fhir.create(context, {
        resourceType: 'Location',
        id,
        status: 'active',
        name: nameZh,
        alias: [nameEn],
        managingOrganization: { reference: 'Organization/organization-clinmesh' },
        ...(id === 'location-outpatient'
          ? {
              type: [{
                coding: [{
                  code: 'outpatient-registration',
                  system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/location-purpose',
                }],
              }],
            }
          : {}),
      })
    }
    for (const account of syntheticAccounts) {
      this.#fhir.create(context, {
        resourceType: 'Practitioner',
        id: account.practitionerId,
        active: true,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-practitioner',
          value: `CM-SYN-${account.roleCode.toUpperCase()}`,
        }],
        name: [{ text: account.name }],
      })
      this.#fhir.create(context, {
        resourceType: 'PractitionerRole',
        id: `practitioner-role-${account.roleCode}`,
        active: true,
        practitioner: { reference: `Practitioner/${account.practitionerId}` },
        organization: { reference: 'Organization/organization-clinmesh' },
        code: [{ text: account.roleCode }],
        location: [{ reference: `Location/location-${account.roleCode}` }],
      })
    }
    const legacyMedications = input.blueprint.medicationRulesVersion === 'prescription-conclusion-v1'
      ? hospitalBaseline.catalog.medications.map(medication => ({
          code: medication.code,
          id: medication.id,
          name: medication.name,
          product: medication.product,
        }))
      : [{
          code: 'ACETAMINOPHEN',
          id: 'medication-acetaminophen',
          name: '对乙酰氨基酚片',
          product: undefined,
        }]
    const medications = [{
        id: 'medication-oseltamivir',
        code: 'OSELTAMIVIR',
        name: '磷酸奥司他韦胶囊',
        product: undefined,
      }, ...legacyMedications]
    for (const medication of medications) {
      this.#fhir.create(context, {
        resourceType: 'Medication',
        id: medication.id,
        status: 'active',
        code: {
          coding: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
            code: medication.code,
            display: medication.name,
          }, ...(medication.product === undefined ? [] : [{
            code: medication.product.code,
            display: medication.product.genericName,
            system: medication.product.system,
            version: medication.product.version,
          }])],
          text: medication.name,
        },
      })
    }
    const inventoryLots = this.#database.driver.prepare(`
      SELECT lot.lot_id, lot.lot_number, lot.expires_on, lot.quantity_on_hand,
        lot.location_id, lot.medication_id, catalog.code, catalog.name_zh
      FROM inventory_lot AS lot
      JOIN outpatient_catalog AS catalog
        ON catalog.workspace_id = lot.workspace_id
       AND catalog.epoch = lot.epoch
       AND catalog.item_id = lot.medication_id
      WHERE lot.workspace_id = ? AND lot.epoch = ?
      ORDER BY lot.lot_id
    `).all(input.workspaceId, input.epoch) as Array<{
      code: string
      expires_on: string
      location_id: string
      lot_id: string
      lot_number: string
      medication_id: string
      name_zh: string
      quantity_on_hand: number
    }>
    for (const lot of inventoryLots) {
      this.#fhir.createProjection(context, {
        resourceType: 'InventoryItem',
        id: lot.lot_id,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-inventory-lot',
          value: lot.lot_number,
        }],
        status: 'active',
        category: [{ text: 'Synthetic medication lot' }],
        code: [{
          coding: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
            code: lot.code,
            display: lot.name_zh,
          }],
          text: lot.name_zh,
        }],
        baseUnit: {
          coding: [{ system: 'http://unitsofmeasure.org', code: '1', display: 'unit' }],
          text: 'unit',
        },
        netContent: {
          value: lot.quantity_on_hand,
          unit: 'unit',
          system: 'http://unitsofmeasure.org',
          code: '1',
        },
        instance: {
          lotNumber: lot.lot_number,
          expiry: lot.expires_on,
          location: { reference: `Location/${lot.location_id}` },
        },
        productReference: { reference: `Medication/${lot.medication_id}` },
      })
    }
    if (input.blueprint.kind !== 'density') return
    for (let index = 1; index <= 120; index += 1) {
      const sequence = String(index).padStart(3, '0')
      this.#fhir.create(context, {
        resourceType: 'Patient',
        id: `density-patient-${sequence}`,
        active: true,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-patient',
          value: `CM-DENSITY-${sequence}`,
        }],
        name: [{ text: `合成密度患者${sequence}` }],
        gender: index % 2 === 0 ? 'female' : 'male',
        birthDate: `${1970 + index % 35}-06-15`,
        extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
          valueBoolean: true,
        }],
      })
    }
  }
}
