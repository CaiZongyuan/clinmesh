import type { PathologyReport, PathologyRequest } from '@clinmesh/contracts/his'
import { pathologyReadingMessageSchema, pathologyReadingProtocol, pathologyReadingReadySchema, type PathologyReadingSession } from '@clinmesh/contracts/pathology-reading'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../api-client.ts'
import { closePathologyReading, getPathologyReading, markPathologyReadingDisplayed, openPathologyReading } from '../pathology-reading-api.ts'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

/** 两个病理入口共用受限外部阅片外壳，短效启动凭据仅驻留本次挂载的内存。 */
export function PathologyReadingViewer({ request, report, locale, onReady, onSession, retainSession = false }: {
  request: PathologyRequest; report: PathologyReport; locale: WorkspaceLocale; onReady: (ready: boolean) => void
  onSession?: ((id: string) => void) | undefined; retainSession?: boolean
}) {
  const frame = useRef<HTMLIFrameElement>(null), container = useRef<HTMLElement>(null), callbacks = useRef(onReady)
  callbacks.current = onReady
  const sessionCallback = useRef(onSession)
  sessionCallback.current = onSession
  const [attempt, setAttempt] = useState(0), [session, setSession] = useState<PathologyReadingSession>(), [failed, setFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false), [fullscreenFailed, setFullscreenFailed] = useState(false)
  const scope = JSON.stringify([request.id, request.version, report.diagnosticReportId, report.diagnosticReportVersion])
  const intent = useRef({ scope, generation: newIdempotencyKey(), key: newIdempotencyKey() })
  if (intent.current.scope !== scope) intent.current = { scope, generation: newIdempotencyKey(), key: newIdempotencyKey() }
  const zh = locale === 'zh-CN'
  useEffect(() => {
    const element = container.current
    const changed = () => setFullscreen(element?.matches(':fullscreen') ?? false)
    document.addEventListener('fullscreenchange', changed)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (element?.matches(':fullscreen')) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])
  const toggleFullscreen = async () => {
    try {
      setFullscreenFailed(false)
      if (fullscreen) await document.exitFullscreen()
      else await container.current?.requestFullscreen()
    } catch { setFullscreenFailed(true) }
  }
  useEffect(() => {
    let disposed = false, invalidated = false, current: PathologyReadingSession | undefined, launched = false, reported = false
    let generation = intent.current.generation
    const key = intent.current.key, closeKey = newIdempotencyKey()
    callbacks.current(false); setSession(undefined); setFailed(false)
    const invalidate = () => {
      invalidated = true
      callbacks.current(false); setFailed(true); setSession(undefined)
      if (current) {
        intent.current = { scope, generation: newIdempotencyKey(), key: newIdempotencyKey() }
        void closePathologyReading(current.id, closeKey).catch(() => undefined)
        current = undefined
      }
    }
    const handleMessage = (event: MessageEvent) => {
      if (disposed || invalidated || !current || event.origin !== current.viewerOrigin || event.source !== frame.current?.contentWindow) return
      if (pathologyReadingReadySchema.safeParse(event.data).success) {
        if (!launched) {
          launched = true
          frame.current?.contentWindow?.postMessage({ protocol: pathologyReadingProtocol, type: 'launch', launchToken: current.launchToken, generation }, current.viewerOrigin)
        }
        return
      }
      const decoded = pathologyReadingMessageSchema.safeParse(event.data)
      if (!decoded.success) return
      const message = decoded.data
      if (message.sessionId !== current.sessionId || message.generation !== generation || message.requestId !== request.id
        || message.reportId !== report.diagnosticReportId || message.reportVersion !== report.diagnosticReportVersion) return
      if (message.type !== 'displayed') { invalidate(); return }
      if (reported) return
      reported = true
      void markPathologyReadingDisplayed(current.id, message).then(result => {
        if (!disposed && !invalidated) callbacks.current(result.active && result.displayed)
      }).catch(() => { if (!disposed) invalidate() })
    }
    window.addEventListener('message', handleMessage)
    void openPathologyReading(request.id, { reportId: report.diagnosticReportId, reportVersion: report.diagnosticReportVersion,
      requestVersion: request.version, generation, parentOrigin: window.location.origin }, key).then(result => {
      current = result
      generation = result.generation
      if (disposed) { void closePathologyReading(result.id, closeKey).catch(() => undefined); return }
      setSession(result)
      sessionCallback.current?.(result.id)
    }).catch(() => { if (!disposed) invalidate() })
    const interval = window.setInterval(() => {
      if (!current || disposed || invalidated) return
      const writable = current.writable
      void getPathologyReading(current.id).then(result => { if (!disposed && (!result.active || writable && !result.writable)) invalidate() })
        .catch(() => { if (!disposed) invalidate() })
    }, 5000)
    return () => {
      disposed = true
      if (!retainSession) callbacks.current(false)
      window.clearInterval(interval); window.removeEventListener('message', handleMessage)
      if (current && !retainSession) void closePathologyReading(current.id, closeKey).catch(() => undefined)
    }
  }, [request.id, request.version, report.diagnosticReportId, report.diagnosticReportVersion, attempt, retainSession, scope])
  return <section ref={container} aria-label={zh ? '病理切片阅片' : 'Pathology slide viewer'} className="space-y-2 bg-background text-foreground fullscreen:flex fullscreen:flex-col fullscreen:p-3">
    {session && !failed ? <Button size="sm" variant="outline" onClick={() => void toggleFullscreen()}>{fullscreen ? (zh ? '退出全屏' : 'Exit fullscreen') : (zh ? '全屏阅片' : 'Read fullscreen')}</Button> : null}
    {fullscreenFailed ? <p role="status">{zh ? '当前窗口无法进入全屏，可继续在页面内阅片。' : 'Fullscreen is unavailable in this window. Continue reading inline.'}</p> : null}
    {failed ? <div role="status" className="rounded border p-3 text-sm"><p>{zh ? '阅片服务暂不可用。文字报告仍可阅读，恢复后请重新打开切片。' : 'The slide service is unavailable. The text report remains readable.'}</p>
      <Button size="sm" variant="outline" onClick={() => {
        if (session) intent.current = { scope, generation: newIdempotencyKey(), key: newIdempotencyKey() }
        setAttempt(value => value + 1)
      }}>{zh ? '重新打开切片' : 'Reopen slide'}</Button></div>
      : session ? <iframe ref={frame} title={zh ? '病理切片阅片' : 'Pathology slide viewer'} src={session.viewerUrl}
        className="h-[min(75vh,720px)] min-h-96 w-full border fullscreen:flex-1" style={fullscreen ? { flex: 1, height: '100%', minHeight: 0 } : undefined} allow="fullscreen" sandbox="allow-scripts allow-same-origin allow-forms" />
        : <p role="status" className="p-3 text-sm">{zh ? '正在连接阅片服务' : 'Connecting to slide service'}</p>}
  </section>
}
