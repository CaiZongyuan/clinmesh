import { patientPersonaContentSchema } from '@clinmesh/contracts/scenario'

/** 固定合成患者的可知自述；与私有作者底稿及本院诊疗事实分开维护。 */
export const pciPatientPersonaTemplate = {
  version: 'clinmesh-pci-patient-persona-v1',
  content: patientPersonaContentSchema.parse({
    chiefComplaint: '活动后胸闷三个月，加重一周，休息可缓解。',
    openingStatement: '医生您好，最近一活动胸口就闷，休息后会好。',
    knownHistorySummary: '无已知药物过敏，静息无胸痛。',
    symptomExperience: '步行数百米后胸口闷，停下休息几分钟会缓解，没有晕厥。',
    medicationMemory: '近期未自行加药。',
    persona: { character: '平和', speechStyle: '简短清楚', healthLiteracy: '普通', attitude: '愿意配合检查' },
  }),
}
