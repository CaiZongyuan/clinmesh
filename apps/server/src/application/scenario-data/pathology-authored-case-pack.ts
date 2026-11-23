import { compileAuthoredCasePack, type AuthoredCasePackDefinitionInput } from './authored-case-pack-compiler.ts'

const snomed = 'http://snomed.info/sct'
const indexDateTime = '2026-08-24T08:00:00+08:00'

/** 确定性的既往标本会诊病例；既往取材是来源事实，本院只实施会诊，不生成或运行模型。 */
export const pathologyAuthoredCasePackDefinition: AuthoredCasePackDefinitionInput = {
  id: 'clinmesh-pathology-consultations-v1',
  name: '结直肠与甲状腺既往切片会诊病例',
  nameEn: 'Prior colorectal and thyroid slide consultations',
  version: '1',
  cases: [
    {
      id: 'pathology-colorectal-polypectomy-v1',
      title: '既往结直肠息肉切除切片会诊',
      titleEn: 'Prior colorectal polypectomy slide consultation',
      chiefComplaint: '外院息肉切除后携既往切片复核。',
      indexDateTime,
      indexConditions: [{ id: 'follow-up', system: snomed, code: '183707008', display: '随访就诊' }],
      laboratories: [],
      patient: { birthDate: '1968-04-12', gender: 'male', id: 'authored-pathology-colorectal-01', name: '合成周正宁' },
      persona: { version: 'pathology-colorectal-persona-v1', content: {
        chiefComplaint: '一个月前在外院切除了肠息肉，带切片来复核。',
        knownHistorySummary: '一个月前肠镜发现息肉并切除，复查时携原切片来院。',
        medicationMemory: '目前没有规律服药，术后没有再次便血。',
        openingStatement: '医生您好，我上个月切了一个肠息肉，今天带着原来的切片来请您帮我复核一下。',
        persona: { attitude: '愿意配合复核与随访', character: '平和', healthLiteracy: '普通', speechStyle: '简明清楚' },
        symptomExperience: '目前没有腹痛、便血或发热，饮食和排便基本正常。',
      } },
      plannedStentCount: 0,
      recommendedEntry: 'outpatient',
      visibleHistory: [{
        id: 'prior-polypectomy', encounterDateTime: '2026-07-20T09:00:00+08:00', reasonText: '外院结直肠息肉切除',
        conditions: [{ id: 'colorectal-polyp', system: snomed, code: '68496003', display: '结肠息肉' }],
        procedures: [{ id: 'polypectomy', coding: { code: '274025005', display: '结肠镜下息肉切除术', system: snomed } }],
      }],
    },
    {
      id: 'pathology-thyroid-surgery-v1',
      title: '既往甲状腺手术切片会诊',
      titleEn: 'Prior thyroid surgery slide consultation',
      chiefComplaint: '外院甲状腺手术后携既往切片复核。',
      indexDateTime,
      indexConditions: [{ id: 'follow-up', system: snomed, code: '183707008', display: '随访就诊' }],
      laboratories: [],
      patient: { birthDate: '1976-09-18', gender: 'female', id: 'authored-pathology-thyroid-01', name: '合成林若安' },
      persona: { version: 'pathology-thyroid-persona-v1', content: {
        chiefComplaint: '两个月前在外院做了甲状腺手术，带原切片来复核。',
        knownHistorySummary: '两个月前因甲状腺结节在外院接受手术，目前携原切片来院。',
        medicationMemory: '术后按外院医嘱随访，今天主要咨询原切片复核。',
        openingStatement: '医生您好，我前段时间做了甲状腺手术，今天带着手术时的切片过来复核。',
        persona: { attitude: '希望了解复核与后续随访', character: '细致', healthLiteracy: '普通', speechStyle: '平稳清晰' },
        symptomExperience: '颈部伤口已愈合，没有发热、声音嘶哑或手脚麻木。',
      } },
      plannedStentCount: 0,
      recommendedEntry: 'outpatient',
      visibleHistory: [{
        id: 'prior-thyroidectomy', encounterDateTime: '2026-06-18T09:00:00+08:00', reasonText: '外院甲状腺结节手术',
        conditions: [{ id: 'thyroid-nodule', system: snomed, code: '237495005', display: '甲状腺结节' }],
        procedures: [{ id: 'thyroidectomy', coding: { code: '13619001', display: '甲状腺切除术', system: snomed } }],
      }],
    },
  ],
}

export const compiledPathologyAuthoredCasePack = compileAuthoredCasePack(pathologyAuthoredCasePackDefinition)
