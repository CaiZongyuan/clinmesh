import { z } from 'zod'
import { shanghaiBusinessDate } from '@clinmesh/contracts/scenario'
import type { GuidelinePatientPopulation } from './guideline-corpus.ts'

const calendarDateSchema = z.iso.date()

/** 年龄：以医院当地（Asia/Shanghai）日期计算整岁和日龄；非法、缺失或晚于参考日期时返回 ageYears: -1。 */
export function ageAt(birthDate: string, at: string | undefined): { ageYears: number, ageDays: number | null } {
  if (!calendarDateSchema.safeParse(birthDate).success) return { ageYears: -1, ageDays: null }
  let referenceDate: string
  if (at !== undefined && calendarDateSchema.safeParse(at).success) {
    referenceDate = at
  } else {
    const referenceTime = at === undefined ? new Date() : new Date(at)
    if (Number.isNaN(referenceTime.getTime())) return { ageYears: -1, ageDays: null }
    referenceDate = shanghaiBusinessDate(referenceTime.toISOString())
  }
  const birth = new Date(birthDate)
  const reference = new Date(referenceDate)
  if (birth > reference) return { ageYears: -1, ageDays: null }
  const days = Math.max(0, Math.floor((reference.getTime() - birth.getTime()) / 86_400_000))
  let years = reference.getUTCFullYear() - birth.getUTCFullYear()
  if (reference.getUTCMonth() < birth.getUTCMonth()
    || (reference.getUTCMonth() === birth.getUTCMonth() && reference.getUTCDate() < birth.getUTCDate())) years -= 1
  return { ageYears: Math.min(150, Math.max(0, years)), ageDays: years === 0 ? days : null }
}

export function resolvePatientGuidelinePopulation(
  birthDate: string | undefined,
  referenceTime: string | undefined,
): GuidelinePatientPopulation {
  if (!birthDate || !referenceTime) return 'all-only'
  const { ageYears } = ageAt(birthDate, referenceTime)
  if (ageYears < 0) return 'all-only'
  return ageYears >= 18 ? 'adult' : 'pediatric'
}
