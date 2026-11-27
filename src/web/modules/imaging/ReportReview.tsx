import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { frameList, type ReviewMode, type StudyKind, type StudyView } from '../../../packages/diagnostic-workflow';
import { Button, ConfirmActionButton } from '../../../packages/ui-kit';
import { api, ApiError, errorMessage, scopeKey, words, type Language, type Session } from '../../workbench-api';

type Report = StudyView['orders'][number]['reports'][number];
type Props = { session: Session; encounterId: string; kind: StudyKind; report: Report; language: Language; canView: boolean; busy: boolean; acknowledge?(mode: ReviewMode): void; amend?(): void };

export function ReportReview({ session, encounterId, kind, report, language, canView, busy, acknowledge, amend }: Props) {
  const text = words(language);
  const [open, setOpen] = useState(false);
  const [renderMode, setRenderMode] = useState<ReviewMode>();
  const firstFrame = useCallback(() => setRenderMode('first-frame-rendered'), []);
  const unavailable = useCallback(() => setRenderMode(current => current === 'first-frame-rendered' ? current : 'frames-unavailable'), []);
  const query = useQuery({ queryKey: scopeKey(session, encounterId, kind, session.roleId, report.id, 'frames'), enabled: open && canView,
    gcTime: 0, staleTime: Infinity, retry: false, queryFn: async ({ signal }) => {
      const [assets, viewer] = await Promise.all([api(`/api/his/encounters/${encounterId}/${kind}/reports/${report.id}/frames`, frameList, { signal }), import('./CanvasViewer')]);
      if (assets.reportId !== report.id || assets.frames.length !== report.frameCount) throw new ApiError(409, 'REPORT_SUPERSEDED');
      return { frames: assets.frames, Viewer: viewer.default };
    } });
  const accessError = query.error instanceof ApiError && query.error.status < 500;
  const mode = renderMode ?? (query.isError && !accessError ? 'frames-unavailable' : !report.requireFirstFrame ? 'text' : undefined);
  const sections = report.sections;
  const items = sections.kind === 'imaging'
    ? [[text('Radiographic findings', '放射所见'), sections.findings[language]], [text('Impression', '诊断印象'), sections.impression[language]]]
    : [[text('Microscopy', '镜下所见'), sections.microscopy[language]], [text('Pathologic diagnosis', '病理诊断'), sections.diagnosis[language]]];
  const confirmLabel = mode === 'frames-unavailable' ? text('Acknowledge text report with images unavailable', '图像不可用，确认已阅文字报告') : text('Acknowledge this report version', '确认已阅本版报告');
  return <section className="clinical-panel"><p>{report.signedAt} · {report.acknowledged ? `${text('Acknowledged by', '已阅岗位')} ${report.acknowledged.role} · ${report.acknowledged.at}` : text('Awaiting acknowledgement', '待确认已阅')}</p>
    <dl>{items.map(([label, content]) => <div key={label}><dt><strong>{label}</strong></dt><dd>{content}</dd></div>)}</dl>
    {report.amendmentReason && <p>{text('Reason for correction', '更正原因')} · {report.amendmentReason[language]}</p>}
    {canView && report.frameCount > 0 && !open && <Button onClick={() => setOpen(true)}>{text('Open image viewer', '打开阅片器')} · {report.frameCount}</Button>}
    {open && query.isPending && <p role="status">{text('Opening viewer…', '正在打开阅片器…')}</p>}
    {open && query.isError && <p role="alert">{accessError ? errorMessage(query.error, language) : text('Viewer unavailable. Review the signed text report.', '阅片器不可用，请审阅已签发的文字报告。')}</p>}
    {open && canView && query.data && <query.data.Viewer language={language} frames={query.data.frames} onFirstFrame={firstFrame} onUnavailable={unavailable}/>}
    {acknowledge && <ConfirmActionButton disabled={busy || !mode || accessError} confirmation={confirmLabel} onClick={() => { if (mode) acknowledge(mode); }}>{confirmLabel}</ConfirmActionButton>}
    {amend && <ConfirmActionButton disabled={busy} confirmation={text('Sign the authored correction?', '签发预置的更正版本？')} onClick={amend}>{text('Publish correction', '签发更正报告')}</ConfirmActionButton>}
  </section>;
}
