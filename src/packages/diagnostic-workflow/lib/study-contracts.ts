import { z } from 'zod';
import { frameReferenceSchema, studySectionsSchema } from '../../data-pack';
import { localizedName } from '../../platform';
import { orderHeader, reportHeader } from './lifecycle';
import { quote } from './orders';

export const frameList = z.object({ reportId: z.uuidv7(), frames: z.array(frameReferenceSchema).max(128) });
export const storedStudy = z.strictObject({ sections: studySectionsSchema, amendmentReason: localizedName.optional(), frames: frameList.shape.frames, requireFirstFrame: z.boolean() });
export const reviewMode = z.enum(['text', 'first-frame-rendered', 'frames-unavailable']);
const report = reportHeader.extend({ sections: studySectionsSchema, amendmentReason: localizedName.optional(), frameCount: z.int().nonnegative(), requireFirstFrame: z.boolean() });
export const studyViewSchema = z.object({
  services: z.array(z.object({ quote, display: localizedName })),
  orders: z.array(orderHeader.extend({ priorSurgeryId: z.string().nullable(), reports: z.array(report) })),
});
export type StudyKind = z.infer<typeof studySectionsSchema>['kind'];
export type StudyView = z.infer<typeof studyViewSchema>;
export type ReviewMode = z.infer<typeof reviewMode>;
