import { describe, expect, it } from 'vitest'
import { imagingExamCodeSchema, imagingExamPreparationSchema, imagingStudyViewSchema } from '../src/imaging.ts'

const level = (width: number, height: number, micronsPerPixel: number, magnification: number) => ({
  height,
  magnification,
  micronsPerPixel,
  tileHeight: 256,
  tileWidth: 256,
  width,
})
const slideStudy = (levels: unknown[]) => ({
  available: true,
  examCode: 'breast-slide-consultation',
  series: [{ colorManaged: false, kind: 'tiled-pyramid', levels, modality: 'SM', slideLabel: 'A1', tileFormat: 'jpeg' }],
  studyId: 'study-slide',
})

describe('imaging study view', () => {
  it('describes a slide as an RGB tile pyramid ordered from high to low resolution', () => {
    const levels = [level(1000, 700, 0.5, 20), level(500, 350, 1, 10), level(125, 88, 4, 2.5)]
    expect(imagingStudyViewSchema.parse(slideStudy(levels)).series[0]).toMatchObject({ kind: 'tiled-pyramid', levels })
    expect(imagingStudyViewSchema.safeParse(slideStudy([levels[1], levels[0]])).success).toBe(false)
    expect(imagingStudyViewSchema.safeParse(slideStudy([level(1000, 700, 0.25, 40)])).success).toBe(false)
    expect(imagingStudyViewSchema.safeParse({
      ...slideStudy(levels),
      series: [{ ...slideStudy(levels).series[0], colorManaged: true }],
    }).success).toBe(false)
  })

  it('keeps the pathology exam code out of radiology preparation', () => {
    expect(imagingExamCodeSchema.safeParse('breast-slide-consultation').success).toBe(false)
    expect(imagingExamPreparationSchema.safeParse({
      evidence: { facts: [], sourceExams: [] },
      examCode: 'breast-slide-consultation',
      status: 'unsupported',
    }).success).toBe(false)
    expect(imagingStudyViewSchema.safeParse({ available: false, examCode: 'chest-ct-plain', series: [], studyId: 'study-ct' }).success).toBe(true)
  })
})
