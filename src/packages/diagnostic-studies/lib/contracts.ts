import { z } from 'zod';
import { frameReferencesSchema, studySectionsSchema } from '../../data-pack';
import { localizedName } from '../../platform';
import { orderHeader, quote, reportHeader } from '../../diagnostic-workflow';

const reportSections = z.discriminatedUnion('kind', [...studySectionsSchema.options, z.strictObject({ kind: z.literal('summary'), summary: localizedName })]);
export const frameList = z.object({ reportId: z.uuidv7(), frames: frameReferencesSchema });
export const storedStudy = z.strictObject({ sections: reportSections, amendmentReason: localizedName.optional(), frames: frameReferencesSchema, requireFirstFrame: z.boolean() });
export const reviewMode = z.enum(['text', 'first-frame-rendered', 'frames-unavailable']);
const report = reportHeader.extend({ sections: reportSections, amendmentReason: localizedName.optional(), frameCount: z.int().nonnegative(), requireFirstFrame: z.boolean() });
export const studyViewSchema = z.object({
  completedSurgeries: z.array(z.object({ id: z.uuidv7(), performedOn: z.iso.date(), description: localizedName })).default([]),
  services: z.array(z.object({ quote, display: localizedName })),
  orders: z.array(orderHeader.extend({ priorSurgeryId: z.string().nullable(), reports: z.array(report) })),
});
export type StudyKind = z.infer<typeof studySectionsSchema>['kind'];
export type StudyView = z.infer<typeof studyViewSchema>;
export type ReviewMode = z.infer<typeof reviewMode>;
