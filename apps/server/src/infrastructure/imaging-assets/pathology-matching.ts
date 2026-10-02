import type { PathologyFactName, PathologyFactValue } from '@clinmesh/contracts/pathology'
import type { PathologyClinicalFields, PathologyMatchingRules } from './pathology-catalog.ts'
import { pathologyClinicalStatus } from './pathology-report-check.ts'

export type PathologyFacts = Partial<Record<PathologyFactName, PathologyFactValue>>

export const pathologyFactNames = [
  'estrogen-receptor',
  'progesterone-receptor',
  'her2',
  'lymph-nodes',
  'tumor-category',
] as const satisfies readonly PathologyFactName[]

/**
 * 由素材的临床字段派生病例匹配使用的事实。受体状态沿用自动检查的派生规则；淋巴结取病理 N 分期的阴性（N0）或
 * 阳性（N1–N3），肿瘤取病理 T 分期的 T1–T4 类别。来源未给出或写作 NX、TX 的字段不派生事实。
 */
export function pathologyAssetFacts(clinical: PathologyClinicalFields): PathologyFacts {
  const status = pathologyClinicalStatus(clinical)
  const node = /^N([0-3])/.exec(clinical.pathologicN)?.[1]
  const tumor = /^T([1-4])/.exec(clinical.pathologicT)?.[1]
  return {
    ...(status.er === undefined ? {} : { 'estrogen-receptor': status.er }),
    ...(status.pr === undefined ? {} : { 'progesterone-receptor': status.pr }),
    ...(status.her2 === undefined ? {} : { her2: status.her2 }),
    ...(node === undefined ? {} : { 'lymph-nodes': node === '0' ? 'negative' as const : 'positive' as const }),
    ...(tumor === undefined ? {} : { 'tumor-category': `T${tumor}` as PathologyFactValue }),
  }
}

const factLabels: Record<PathologyFactName, string> = {
  'estrogen-receptor': 'ER',
  'her2': 'HER2',
  'lymph-nodes': '淋巴结',
  'progesterone-receptor': 'PR',
  'tumor-category': '',
}
const factSlugs: Record<PathologyFactName, string> = {
  'estrogen-receptor': 'er',
  'her2': 'her2',
  'lymph-nodes': 'ln',
  'progesterone-receptor': 'pr',
  'tumor-category': '',
}

/** 五项事实齐全时的适配条目：标识与名称只由事实组合决定，事实相同的素材属于同一条目。 */
export function pathologyProfile(
  service: PathologyMatchingRules['services'][number],
  facts: PathologyFacts,
): { facts: Record<PathologyFactName, PathologyFactValue>; id: string; label: string } | undefined {
  if (pathologyFactNames.some(name => facts[name] === undefined)) return undefined
  const complete = facts as Record<PathologyFactName, PathologyFactValue>
  const part = (name: PathologyFactName) => name === 'tumor-category'
    ? { label: complete[name], slug: complete[name].toLowerCase() }
    : {
        label: `${factLabels[name]}${name === 'lymph-nodes' ? '' : ' '}${complete[name] === 'positive' ? '阳性' : '阴性'}`,
        slug: `${factSlugs[name]}-${complete[name] === 'positive' ? 'pos' : 'neg'}`,
      }
  const parts = pathologyFactNames.map(part)
  return {
    facts: complete,
    id: [service.profilePrefix, ...parts.map(item => item.slug)].join('-'),
    label: `${service.label}：${parts.map(item => item.label).join(' · ')}`,
  }
}
