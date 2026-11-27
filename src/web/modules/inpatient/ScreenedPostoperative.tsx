import { useQuery } from '@tanstack/react-query';
import { orderSetsSchema } from '../../../packages/mod-cds';
import { consumeStagedMembers, useOrderSetDraft } from '../../encounter-drafts';
import { api, errorMessage, scopeKey, words } from '../../workbench-api';
import { OrderSet } from '../cds/CdsPanel';
import { OrderComposer } from './clinical';
import type { StageProps } from './controls';

export default function ScreenedPostoperative(panel: StageProps & { setId: string; executionId: string }) {
  const { ward, workspace, setId, executionId } = panel;
  const text = words(panel.language);
  const staged = useOrderSetDraft(panel.drafts);
  const query = useQuery({ queryKey: scopeKey(workspace, ward.encounterId, 'cds', workspace.roleId, String(ward.version), 'ward-order-sets'), queryFn: ({ signal }) => api(`/api/his/encounters/${ward.encounterId}/cds/order-sets`, orderSetsSchema, { signal }) });
  if (query.isError) return <p role="alert">{errorMessage(query.error, panel.language)}</p>;
  if (!query.data) return <p role="status">{text('Screening order set…', '正在预筛组套…')}</p>;
  const template = query.data.find(row => row.id === setId);
  if (!template) return <p>{text('No applicable postoperative set.', '暂无适用的术后组套。')}</p>;
  const member = staged?.templateId === setId && staged.executionId === executionId ? staged.members.find(item => template.members.some(option => option.catalogId === item.catalogId && ['ready', 'needs-review'].includes(option.status)) && panel.directory.items.some(row => row.id === item.catalogId && (row.kind === 'medications' || row.definition.kind === 'nursing'))) : undefined;
  return <><OrderSet key={`${setId}:${template.members.map(member => member.status).join(',')}`} template={template} executionId={executionId} props={{ ...panel, submit: panel.run, encounter: { id: ward.encounterId, status: 'active', responsibleRole: ward.responsibleRole } }}/>
    {member && <OrderComposer key={`${executionId}:${member.catalogId}`} {...panel} proposed={{ itemId: member.catalogId, executionId }} onSigned={() => consumeStagedMembers(panel.drafts, staged => staged.catalogId === member.catalogId)}/>}</>;
}
