import type {
  InpatientBaseStockMedication,
  InpatientProcedureNursingBinding,
  InpatientSurgicalMedicationPackage,
  InpatientSurgeryMedicationSelection,
  SurgicalMedicationPackageId,
} from '@clinmesh/contracts/inpatient-surgery'
import type { MedicationRoute } from '@clinmesh/contracts/medication-safety'
import { resolveInpatientDose } from './inpatient-dose.ts'
import { medicationDoseConflict, medicationRouteAllowed } from './medication-safety.ts'

export const DEFAULT_INTRAOPERATIVE_MEDICATION_NOTE = '按本台手术台内基数用药登记'

interface SurgicalMedicationPackageTemplateItem {
  readonly medicationId: string
  readonly display: string
  readonly doseText: string
  readonly quantity: number
  readonly unit: string
  readonly routeCode: MedicationRoute
}

interface SurgicalMedicationPackageTemplate {
  readonly id: SurgicalMedicationPackageId
  readonly display: string
  readonly displayEn: string
  readonly procedureCodes: readonly string[]
  readonly items: readonly SurgicalMedicationPackageTemplateItem[]
}

const CORONARY_PROCEDURE_CODES = ['88.5500', '88.5600', '00.6600', '00.6600x008', '36.0700'] as const
const GENERAL_SURGERY_PROCEDURE_CODES = ['47.0100', '51.2300', '53.0001'] as const

const SURGICAL_MEDICATION_PACKAGE_TEMPLATES: readonly SurgicalMedicationPackageTemplate[] = [
  {
    id: 'catheterization-contrast-anticoagulation',
    display: '冠脉造影/PCI 对比剂与抗凝套餐',
    displayEn: 'Coronary angiography / PCI contrast & anticoagulation package',
    procedureCodes: CORONARY_PROCEDURE_CODES,
    items: [
      {
        medicationId: 'medication-pci-iohexol',
        display: '碘海醇注射液',
        doseText: '50 mL',
        quantity: 50,
        unit: 'mL',
        routeCode: 'IV',
      },
      {
        medicationId: 'medication-pci-heparin',
        display: '肝素钠注射液',
        doseText: '1 mL',
        quantity: 1,
        unit: 'mL',
        routeCode: 'IV',
      },
    ],
  },
  {
    id: 'catheterization-local-anesthesia-vasodilator',
    display: '冠脉介入局麻与解痉套餐',
    displayEn: 'Coronary local anesthesia & vasodilator package',
    procedureCodes: CORONARY_PROCEDURE_CODES,
    items: [
      {
        medicationId: 'medication-surgical-lidocaine',
        display: '盐酸利多卡因注射液',
        doseText: '5 mL',
        quantity: 5,
        unit: 'mL',
        routeCode: 'IH',
      },
      {
        medicationId: 'medication-nitroglycerin',
        display: '硝酸甘油片',
        doseText: '0.5 mg',
        quantity: 1,
        unit: '片',
        routeCode: 'SL',
      },
    ],
  },
  {
    id: 'general-surgery-perioperative-fluid',
    display: '普外/腔镜台内基础液体与局麻套餐',
    displayEn: 'General / laparoscopic intraoperative fluid & local anesthesia package',
    procedureCodes: GENERAL_SURGERY_PROCEDURE_CODES,
    items: [
      {
        medicationId: 'medication-sodium-chloride',
        display: '0.9%氯化钠注射液',
        doseText: '500 mL',
        quantity: 1,
        unit: '瓶',
        routeCode: 'IVGTT',
      },
      {
        medicationId: 'medication-surgical-lidocaine',
        display: '盐酸利多卡因注射液',
        doseText: '5 mL',
        quantity: 5,
        unit: 'mL',
        routeCode: 'IH',
      },
    ],
  },
] as const

export function buildSurgicalMedicationPackages(
  baseStockMedications: readonly InpatientBaseStockMedication[],
  inactiveIds: ReadonlySet<string> = new Set(),
): InpatientSurgicalMedicationPackage[] {
  const byId = new Map(baseStockMedications.map(item => [item.id, item]))
  return SURGICAL_MEDICATION_PACKAGE_TEMPLATES.map(template => ({
    id: template.id,
    display: template.display,
    displayEn: template.displayEn,
    procedureCodes: [...template.procedureCodes],
    items: template.items.map((item) => {
      const matched = byId.get(item.medicationId)
      if (!matched) {
        return {
          medicationId: item.medicationId,
          display: item.display,
          doseText: item.doseText,
          quantity: item.quantity,
          unit: item.unit,
          routeCode: item.routeCode,
          available: false,
          catalogVersion: null,
          priceFen: null,
          unavailableReason: inactiveIds.has(item.medicationId) ? 'inactive' as const : 'not-installed' as const,
        }
      }
      return {
        medicationId: matched.id,
        display: matched.display,
        doseText: item.doseText,
        quantity: item.quantity,
        unit: matched.unit,
        routeCode: item.routeCode,
        available: true,
        catalogVersion: matched.version,
        priceFen: matched.priceFen,
      }
    }),
  }))
}

export function packagesForProcedureCode(
  packages: readonly InpatientSurgicalMedicationPackage[],
  procedureCode: string | null | undefined,
): InpatientSurgicalMedicationPackage[] {
  if (!procedureCode) return []
  return packages.filter(pkg => pkg.procedureCodes.includes(procedureCode))
}

export function linkedNursingForProcedureId(
  bindings: readonly InpatientProcedureNursingBinding[],
  procedureId: string | null | undefined,
): Omit<InpatientProcedureNursingBinding, 'procedureIds'> | undefined {
  if (!procedureId) return undefined
  const found = bindings.find(binding => binding.procedureIds.includes(procedureId))
  if (!found) return undefined
  const { procedureIds: _ids, ...rest } = found
  return rest
}

export type SurgicalMedicationValidationResult =
  | { ok: true; quantity: number }
  | { ok: false; reason: 'MEDICATION_ROUTE_NOT_ALLOWED' | 'MEDICATION_DOSAGE_NOT_ALLOWED' }

export function surgicalMedicationSafetyDose(
  medication: Pick<InpatientBaseStockMedication, 'unit' | 'doseBasis' | 'safety'>,
  doseText: string,
  quantity: number,
): string {
  const limitsUnit = medication.safety?.doseLimits.unit
  if (!limitsUnit) return doseText
  const match = /^(\d+(?:\.\d+)?)\s*([^\s\d]+)$/.exec(doseText.trim())
  if (match && match[2] === limitsUnit) return doseText
  if (medication.unit === limitsUnit) return `${quantity} ${limitsUnit}`
  if (medication.doseBasis && medication.doseBasis.unit === limitsUnit) {
    return `${quantity * medication.doseBasis.amount} ${limitsUnit}`
  }
  return doseText
}

export function validateSurgicalMedicationSelection(
  medication: InpatientBaseStockMedication,
  selection: InpatientSurgeryMedicationSelection,
): SurgicalMedicationValidationResult {
  if (!medicationRouteAllowed(medication.allowedRouteCodes, selection.routeCode)) {
    return { ok: false, reason: 'MEDICATION_ROUTE_NOT_ALLOWED' }
  }
  const resolved = resolveInpatientDose(
    {
      unit: medication.unit,
      doses: medication.doses,
      ...(medication.doseBasis === undefined ? {} : { doseBasis: medication.doseBasis }),
      maxDoseQuantity: medication.maxDoseQuantity,
    },
    selection.doseText,
  )
  if (!('quantity' in resolved) || resolved.quantity !== selection.quantity) {
    return { ok: false, reason: 'MEDICATION_DOSAGE_NOT_ALLOWED' }
  }
  if (medication.safety) {
    const safetyDose = surgicalMedicationSafetyDose(medication, selection.doseText, selection.quantity)
    if (medicationDoseConflict(medication.safety.doseLimits, safetyDose, 'ONCE') !== undefined) {
      return { ok: false, reason: 'MEDICATION_DOSAGE_NOT_ALLOWED' }
    }
  }
  return { ok: true, quantity: resolved.quantity }
}
