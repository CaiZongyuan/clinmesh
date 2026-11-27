import { readClinicalCase } from '../data-pack';
import { z } from 'zod';
import { createStudyModule } from '../diagnostic-studies';
import type { DiagnosticBillingPort } from '../diagnostic-workflow';
import { CoreError, localizedName } from '../platform';
import type { StoreReader, StoreScope } from '../store';

function completedProcedure(reader: StoreReader, at: StoreScope, encounterId: string, executionId: string) {
  if (!z.uuidv7().safeParse(executionId).success) return undefined;
  const stage = reader.list(at, 'ward_surgery_stages', { completed_execution_id: executionId })[0];
  const order = stage && reader.get(at, 'clinical_orders', stage.order_id);
  if (!stage || order?.encounter_id !== encounterId) return undefined;
  const catalog = reader.get(at, 'catalog_items', order.catalog_item_id)!;
  return { codeSystem: catalog.code_system, code: catalog.code, executionStage: stage.stage };
}

export const createPathologyModule = (billing?: DiagnosticBillingPort) => createStudyModule({
  kind: 'pathology', label: { en: 'Pathology', zh: '病理会诊' }, gateLabel: { en: 'Pathology reports acknowledged', zh: '病理报告已阅' },
  completedProcedure,
  completedSurgeries({ reader, actor, targetId, moduleEnabled }) {
    if (!moduleEnabled?.('mod-inpatient')) return [];
    return reader.list(actor.at, 'clinical_orders', { encounter_id: targetId, kind: 'surgery' }).flatMap(order => {
      const stage = reader.list(actor.at, 'ward_surgery_stages', { order_id: order.id })[0];
      const execution = stage?.completed_execution_id && reader.get(actor.at, 'surgery_executions', stage.completed_execution_id);
      if (!execution) return [];
      return [{ id: execution.id, performedOn: execution.virtual_at.slice(0, 10), description: localizedName.parse(reader.get(actor.at, 'catalog_items', order.catalog_item_id)!.definition.display) }];
    });
  },
  validateHistory({ tx, at, moduleEnabled }, encounter, priorSurgeryId) {
    const patient = readClinicalCase(tx, at, encounter.source_case_id);
    if (patient?.priorHistory.surgeries?.some(surgery => surgery.id === priorSurgeryId)) return;
    if (moduleEnabled?.('mod-inpatient') && priorSurgeryId && completedProcedure(tx, at, encounter.id, priorSurgeryId)) return;
    throw new CoreError(409, 'VISIBLE_SURGERY_REQUIRED');
  },
}, billing);
