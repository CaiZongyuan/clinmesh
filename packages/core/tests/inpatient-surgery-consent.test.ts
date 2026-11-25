import { describe, expect, it } from 'vitest'
import { inpatientSurgicalConsentDocumentSchema } from '@clinmesh/contracts/inpatient-surgery'
import {
  SURGICAL_LOCATIONS,
  buildSurgicalConsentDocument,
  buildSurgeryServiceRequestFields,
  formatAnesthesiaMethod,
  formatConsentSignerRole,
  formatPractitionerDisplay,
  formatPreopOrderPolicy,
  formatSurgeryType,
  formatSurgicalConsentSummaryNote,
  recommendedAnesthesiaMethod,
  recommendedPreopOrderPolicy,
  recommendedSurgeryLocationId,
  resolveSurgicalConsentTemplate,
} from '../src/inpatient-surgery-consent.ts'

describe('inpatient-surgery-consent', () => {
  it('formats controlled surgery types, anesthesia methods, signer roles, and recommends defaults by procedure', () => {
    expect(SURGICAL_LOCATIONS.map(item => item.id)).toEqual([
      'location-catheterization-lab',
      'location-operating-center',
      'location-endoscopy-suite',
      'location-outpatient-or',
    ])
    expect(formatSurgeryType('elective', 'zh-CN')).toBe('择期手术')
    expect(formatSurgeryType('emergency', 'en-US')).toBe('Emergency')
    expect(formatAnesthesiaMethod('local-infiltration', 'zh-CN')).toBe('局部浸润麻醉')
    expect(formatAnesthesiaMethod('general', 'en-US')).toBe('General anesthesia')
    expect(formatConsentSignerRole('family-proxy', 'zh-CN')).toBe('患者近亲属/受托人')
    expect(formatPractitionerDisplay({ id: 'p-1', name: '林海', title: '主任医师' })).toBe('林海（主任医师）')

    expect(recommendedSurgeryLocationId({ coding: { category: '诊断性操作', code: '88.5500' } })).toBe('location-catheterization-lab')
    expect(recommendedAnesthesiaMethod({ coding: { category: '介入治疗', code: '36.0700' } })).toBe('local-infiltration')
    expect(recommendedSurgeryLocationId({ coding: { category: '手术', code: '47.0100' } })).toBe('location-operating-center')
    expect(recommendedAnesthesiaMethod({ coding: { category: '手术', code: '47.0100' } })).toBe('general')
    expect(recommendedAnesthesiaMethod({ coding: { category: '手术', code: '53.0001' } })).toBe('neuraxial')
    expect(formatPreopOrderPolicy('continue-active', 'zh-CN')).toBe('继续术前有效长期医嘱（常规介入/局麻）')
    expect(formatPreopOrderPolicy('stop-on-completion', 'en-US')).toBe('Auto-stop active pre-op long-term orders on completion')
    expect(recommendedPreopOrderPolicy({ coding: { category: '介入治疗', code: '36.0700' } }, 'local-infiltration')).toBe('continue-active')
    expect(recommendedPreopOrderPolicy({ coding: { category: '诊断性操作', code: '88.5600' } }, 'local-sedation')).toBe('continue-active')
    expect(recommendedPreopOrderPolicy({ coding: { category: '手术', code: '51.2300' } }, 'general')).toBe('stop-on-completion')
    expect(recommendedPreopOrderPolicy({ coding: { category: '手术', code: '53.0001' } }, 'neuraxial')).toBe('stop-on-completion')
    expect(recommendedPreopOrderPolicy({ coding: { category: '介入治疗', code: '36.0700' } }, 'general')).toBe('stop-on-completion')
  })

  it('maps coronary angiography, DES PCI, balloon PCI, and general surgery to distinct procedure-specific consent templates', () => {
    const angio = resolveSurgicalConsentTemplate('88.5500')
    const des = resolveSurgicalConsentTemplate('36.0700')
    const balloon = resolveSurgicalConsentTemplate('00.6600x008')
    const general = resolveSurgicalConsentTemplate('47.0100')

    expect(angio.id).toBe('coronary-angiography')
    expect(des.id).toBe('coronary-des-pci')
    expect(balloon.id).toBe('coronary-balloon-pci')
    expect(general.id).toBe('general-surgery')
    expect(angio.title).not.toBe(des.title)
    expect(des.commonRisks.some(item => item.includes('支架内血栓'))).toBe(true)
    expect(angio.commonRisks.some(item => item.includes('对比剂相关性急性肾损伤'))).toBe(true)
    expect(general.commonRisks.some(item => item.includes('中转开腹'))).toBe(true)
  })

  it('builds immutable structured consent documents with synthetic clinical teaching disclaimer and FHIR R5 ServiceRequest projection', () => {
    const doc = buildSurgicalConsentDocument({
      patient: {
        name: '合成冠脉患者',
        gender: 'male',
        birthDate: '1965-05-12',
        inpatientNumber: 'ZY-2026-0001',
      },
      primaryDiagnosis: { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病' },
      surgeryNotice: {
        surgeryType: 'elective',
        procedureCode: '36.0700',
        procedureDisplay: '药物洗脱冠状动脉支架置入',
        plannedFor: '2026-08-25T09:30:00+08:00',
        locationName: '导管室',
        anesthesiaMethod: 'local-infiltration',
        surgeonName: '林海（主任医师）',
        assistantName: '陈铭（主治医师）',
      },
      individualizedRisks: '患者合并慢性肾脏病 G3b 期，围术期对比剂肾损伤风险升高，已行水化方案沟通。',
      signature: {
        signerRole: 'family-proxy',
        signerName: '张家属',
        signerRelationship: '配偶',
        talkingDoctorId: 'practitioner-inpatient-doctor',
        talkingDoctorName: '合成住院医生',
        signedAt: '2026-08-24T10:15:00+08:00',
      },
    })

    expect(inpatientSurgicalConsentDocumentSchema.parse(doc)).toEqual(doc)
    expect(doc.disclaimer).toContain('合成临床教学文书模板')
    expect(doc.templateId).toBe('coronary-des-pci')
    expect(doc.renderedText).toContain('I25.103 冠状动脉粥样硬化性心脏病')
    expect(doc.renderedText).toContain('第一助手：陈铭（主治医师）')
    expect(doc.renderedText).toContain('慢性肾脏病 G3b 期')
    expect(formatSurgicalConsentSummaryNote(doc, '已完成家属谈话')).toContain('患者受托人张家属（配偶）已签署')

    const fhirFields = buildSurgeryServiceRequestFields({
      surgeryType: 'emergency',
      location: { id: 'location-catheterization-lab', name: '导管室' },
      surgeon: { id: 'practitioner-inpatient-doctor', name: '合成住院医生' },
      assistant: { id: 'practitioner-surgeon-attending', name: '陈铭', title: '主治医师' },
      anesthesiaMethod: 'local-infiltration',
      preopOrderPolicy: 'continue-active',
    })
    expect(fhirFields.priority).toBe('stat')
    expect(fhirFields.location).toEqual([{ reference: { reference: 'Location/location-catheterization-lab', display: '导管室' } }])
    expect(fhirFields.performer).toHaveLength(2)
    expect(fhirFields.orderDetail[0]?.parameter[0]?.valueCodeableConcept.text).toBe('局部浸润麻醉')
    expect(fhirFields.orderDetail[0]?.parameter[1]).toMatchObject({
      code: { coding: [{ code: 'preop-order-policy' }] },
      valueCodeableConcept: {
        coding: [{ code: 'continue-active', display: '继续术前有效长期医嘱（常规介入/局麻）' }],
        text: '继续术前有效长期医嘱（常规介入/局麻）',
      },
    })
  })

  it('selects the joint CAG + Ad-hoc PCI consent template and ServiceRequest orderDetail when standbyAdHocPci is enabled', () => {
    const joint = resolveSurgicalConsentTemplate('88.5500', true)
    expect(joint.id).toBe('coronary-angiography-ad-hoc-pci')
    expect(joint.title).toContain('必要时同台经皮冠状动脉介入治疗')
    expect(joint.commonRisks.some(item => item.includes('支架内血栓'))).toBe(true)
    expect(joint.commonRisks.some(item => item.includes('对比剂相关性急性肾损伤'))).toBe(true)
    expect(resolveSurgicalConsentTemplate('47.0100', true).id).toBe('general-surgery')

    const doc = buildSurgicalConsentDocument({
      patient: {
        name: '合成同台患者',
        gender: 'male',
        birthDate: '1965-05-12',
        inpatientNumber: 'ZY-2026-0002',
      },
      primaryDiagnosis: { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病' },
      surgeryNotice: {
        surgeryType: 'elective',
        procedureCode: '88.5500',
        procedureDisplay: '冠状动脉造影',
        plannedFor: '2026-08-25T09:30:00+08:00',
        locationName: '导管室',
        anesthesiaMethod: 'local-infiltration',
        surgeonName: '林海（主任医师）',
        assistantName: null,
        standbyAdHocPci: true,
      },
      signature: {
        signerRole: 'patient',
        signerName: '合成同台患者',
        talkingDoctorId: 'practitioner-inpatient-doctor',
        talkingDoctorName: '合成住院医生',
        signedAt: '2026-08-24T10:15:00+08:00',
      },
    })
    expect(inpatientSurgicalConsentDocumentSchema.parse(doc)).toEqual(doc)
    expect(doc.templateId).toBe('coronary-angiography-ad-hoc-pci')
    expect(doc.surgeryNotice.standbyAdHocPci).toBe(true)
    expect(doc.renderedText).toContain('同台备选：必要时同台转行经皮冠状动脉介入治疗')

    const fhirFields = buildSurgeryServiceRequestFields({
      surgeryType: 'elective',
      location: { id: 'location-catheterization-lab', name: '导管室' },
      surgeon: { id: 'practitioner-inpatient-doctor', name: '合成住院医生' },
      anesthesiaMethod: 'local-infiltration',
      preopOrderPolicy: 'continue-active',
      standbyAdHocPci: true,
    })
    expect(fhirFields.orderDetail[0]?.parameter).toHaveLength(3)
    expect(fhirFields.orderDetail[0]?.parameter[2]).toMatchObject({ valueBoolean: true })
  })
})
