import { createHash } from 'node:crypto'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { z } from 'zod'
import type { ActorContext, CommandResponse } from './command-executor.ts'
import { CommandExecutor } from './command-executor.ts'
import { syntheticAccounts } from './identity-service.ts'

const clinicalReviewSchema = z.record(z.string(), z.unknown())

const scenarioBlueprints = {
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
    virtualPatients: [{
      id: 'virtual-patient-fever-001',
      patientId: 'candidate-patient-001',
      presentation: {
        chiefComplaint: '发热、咽痛 1 天。',
        summary: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛。',
        vitalSigns: {
          bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
          oxygenSaturationPct: 98,
          pulseBpm: 96,
          respirationBpm: 20,
          temperatureC: 38.6,
        },
      },
      questions: [{
        answer: '昨天傍晚开始发热，最高量到 38.7 °C。',
        code: 'symptom-onset',
        factCode: null,
        ordinal: 1,
        revealedAnswer: null,
        text: '什么时候开始发热？',
        version: 1,
      }, {
        answer: '咽痛，吞咽时更明显，没有气促。',
        code: 'associated-symptoms',
        factCode: null,
        ordinal: 2,
        revealedAnswer: null,
        text: '除了发热，还有哪里不舒服？',
        version: 1,
      }, {
        answer: '目前还不知道，需要等检查结果。',
        code: 'infection-cause',
        factCode: 'respiratory-pathogen',
        ordinal: 3,
        revealedAnswer: '检验结果显示是甲型流感病毒感染。',
        text: '知道是什么感染引起的吗？',
        version: 1,
      }],
      version: 1,
    }],
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
    virtualPatients: [],
    scenarioId: 'density-fever-outpatient-v1',
    version: '1.0.0',
    virtualTime: '2026-08-24T09:00:00+08:00',
  },
} as const

type ScenarioBlueprint = (typeof scenarioBlueprints)[keyof typeof scenarioBlueprints]

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
  readonly code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING'
  readonly status: 403 | 404 | 409

  constructor(
    code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING',
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

export class ScenarioService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository

  constructor(database: ClinMeshDatabase, fhir: FhirRepository, commands: CommandExecutor) {
    this.#commands = commands
    this.#database = database
    this.#fhir = fhir
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
        blueprint: scenarioBlueprints.candidate,
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
      input: { scenarioRunId: input.scenarioRunId },
      operation: 'scenario.reset',
    }, () => {
      if (input.context.roleCode !== 'administrator') {
        throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can reset a Scenario Run')
      }
      if (input.scenarioRunId !== input.context.scenarioRunId) {
        throw new ScenarioError('SCENARIO_RUN_CONFLICT', 'The Scenario Run is no longer active')
      }
      const currentState = this.current(input.context)
      const blueprint = Object.values(scenarioBlueprints).find(
        candidate => candidate.scenarioId === currentState.scenarioId,
      ) ?? scenarioBlueprints.candidate
      return this.#transitionEpoch(input.context, blueprint)
    })
  }

  install(input: {
    context: ActorContext
    idempotencyKey: string
    kind: keyof typeof scenarioBlueprints
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
      return this.#transitionEpoch(input.context, scenarioBlueprints[input.kind])
    })
  }

  #transitionEpoch(context: ActorContext, blueprint: ScenarioBlueprint) {
    const sequence = (this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM workspace_epoch WHERE workspace_id = ?
    `).get(context.workspaceId) as { count: number }).count + 1
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
    for (const blueprint of Object.values(scenarioBlueprints)) {
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
    const catalog = [
      ['department-general-medicine', 'department', 'GM', '全科医学科', 'General Medicine', 0, '{}'],
      ['visit-general', 'visit-type', 'GENERAL', '普通门诊挂号费', 'General outpatient registration', 2000, '{}'],
      ['lab-fever-panel', 'laboratory', 'FEVER-PANEL', '发热检验组合', 'Fever laboratory panel', 6800, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['medication-oseltamivir', 'medication', 'OSELTAMIVIR', '磷酸奥司他韦胶囊', 'Oseltamivir phosphate capsules', 760, '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"]}'],
      ['medication-acetaminophen', 'medication', 'ACETAMINOPHEN', '对乙酰氨基酚片', 'Acetaminophen tablets', 120, '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"]}'],
    ] as const
    for (const item of catalog) {
      insertCatalog.run(input.workspaceId, input.epoch, ...item)
    }
    const insertLot = this.#database.driver.prepare(`
      INSERT INTO inventory_lot (
        workspace_id, epoch, lot_id, medication_id, location_id,
        lot_number, expires_on, quantity_on_hand, version
      ) VALUES (?, ?, ?, ?, 'location-pharmacist', ?, '2027-12-31', 1000, 1)
    `)
    insertLot.run(
      input.workspaceId,
      input.epoch,
      'lot-oseltamivir-202608',
      'medication-oseltamivir',
      'SYN-OSE-202608',
    )
    insertLot.run(
      input.workspaceId,
      input.epoch,
      'lot-acetaminophen-202608',
      'medication-acetaminophen',
      'SYN-ACE-202608',
    )
    this.#seedFhirResources(input)
    const insertVirtualPatient = this.#database.driver.prepare(`
      INSERT INTO virtual_patient (
        workspace_id, epoch, virtual_patient_id, version, patient_id,
        clinical_summary_json, available
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
    const insertQuestionRule = this.#database.driver.prepare(`
      INSERT INTO virtual_patient_question_rule (
        workspace_id, epoch, virtual_patient_id, question_code,
        rule_version, ordinal, question_text, answer_text,
        fact_code, revealed_answer_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const patient of blueprint.virtualPatients) {
      insertVirtualPatient.run(
        input.workspaceId,
        input.epoch,
        patient.id,
        patient.version,
        patient.patientId,
        JSON.stringify(patient.presentation),
      )
      for (const question of patient.questions) {
        insertQuestionRule.run(
          input.workspaceId,
          input.epoch,
          patient.id,
          question.code,
          question.version,
          question.ordinal,
          question.text,
          question.answer,
          question.factCode,
          question.revealedAnswer,
        )
      }
    }
  }

  #seedFhirResources(input: {
    blueprint: ScenarioBlueprint
    epoch: string
    workspaceId: string
  }): void {
    const context = { epoch: input.epoch, workspaceId: input.workspaceId }
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
    for (const medication of [{
      id: 'medication-oseltamivir',
      code: 'OSELTAMIVIR',
      name: '磷酸奥司他韦胶囊',
    }, {
      id: 'medication-acetaminophen',
      code: 'ACETAMINOPHEN',
      name: '对乙酰氨基酚片',
    }]) {
      this.#fhir.create(context, {
        resourceType: 'Medication',
        id: medication.id,
        status: 'active',
        code: {
          coding: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
            code: medication.code,
            display: medication.name,
          }],
          text: medication.name,
        },
      })
    }
    if (input.blueprint.kind === 'candidate') {
      this.#fhir.create(context, {
        resourceType: 'Patient',
        id: 'candidate-patient-001',
        active: true,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-patient',
          value: 'CM-CANDIDATE-001',
        }],
        name: [{ text: '合成候选患者林晓' }],
        gender: 'female',
        birthDate: '1988-03-16',
        extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
          valueBoolean: true,
        }],
      })
      this.#fhir.create(context, {
        resourceType: 'Condition',
        id: 'candidate-prior-condition-001',
        clinicalStatus: {
          coding: [{
            code: 'resolved',
            system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          }],
        },
        code: { text: '既往上呼吸道感染（合成）' },
        subject: { reference: 'Patient/candidate-patient-001' },
        recordedDate: '2025-11-08',
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
