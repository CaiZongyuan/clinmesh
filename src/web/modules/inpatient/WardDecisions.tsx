import { useQuery } from '@tanstack/react-query';
import { encounterViewSchema } from '../../../packages/clinical-core';
import { api, errorMessage, scopeKey, words } from '../../workbench-api';
import CdsPanel from '../cds/CdsPanel';
import type { StageProps } from './controls';

export default function WardDecisions(panel: StageProps) {
  const { ward, workspace } = panel;
  const query = useQuery({ queryKey: scopeKey(workspace, ward.encounterId, 'clinical'), queryFn: ({ signal }) => api(`/api/his/encounters/${ward.encounterId}`, encounterViewSchema, { signal }) });
  if (query.isError) return <p role="alert">{errorMessage(query.error, panel.language)}</p>;
  if (!query.data) return <p role="status">{words(panel.language)('Reading encounter…', '正在读取就诊…')}</p>;
  return <CdsPanel {...panel} encounter={query.data} submit={panel.run}/>;
}
