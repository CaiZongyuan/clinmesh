import { z } from 'zod';
import type { Session } from './workbench-api';

const selection = z.object({ caseId: z.uuid().optional(), encounterId: z.uuidv7().optional() });
const storageKey = (session: Session) => `clinmesh.ward.${session.workspaceId}.${session.epoch}`;
export function readWardSelection(session: Session): z.infer<typeof selection> {
  try { return selection.parse(JSON.parse(sessionStorage.getItem(storageKey(session)) ?? '{}')); } catch { return {}; }
}
export function rememberWardSelection(session: Session, value: z.infer<typeof selection>) { sessionStorage.setItem(storageKey(session), JSON.stringify(value)); }
