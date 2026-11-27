import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Button, FileInput, FileInputTrigger } from '../../../packages/ui-kit';
import { words, type Language } from '../../workbench-api';
import { canvasFilter, changeViewport, initialViewport } from './viewport';
import './viewer.css';

type Props = { frames: string[]; language: Language; onFirstFrame(): void; onUnavailable(): void };
type Loaded = { source: string; image?: HTMLImageElement };
const sourceUrl = (reference: string) => reference.startsWith('https://') ? reference : `/clinical-frames/${reference}`;

export default function CanvasViewer(props: Props) {
  const { language } = props;
  const text = words(language);
  const [local, setLocal] = useState<string>();
  useEffect(() => () => { if (local) URL.revokeObjectURL(local); }, [local]);
  return <div className="clinical-panel"><ImageSurface key={local ?? 'report'} {...props} local={local}/>
    <div className="cm-actions"><FileInput accept="image/png,image/webp,image/jpeg" maxSize={12 * 1024 * 1024} onValueChange={files => { if (files[0]) setLocal(URL.createObjectURL(files[0])); }}>
      <FileInputTrigger>{text('Preview a local image', '预览本地图片')}</FileInputTrigger></FileInput>
      {local && <Button onClick={() => setLocal(undefined)}>{text('Return to report frames', '返回报告关键帧')}</Button>}</div>
  </div>;
}

function ImageSurface({ frames, local, language, onFirstFrame, onUnavailable }: Props & { local?: string }) {
  const text = words(language);
  const [view, dispatch] = useReducer(changeViewport, initialViewport);
  const [loaded, setLoaded] = useState<Loaded>();
  const [drawError, setDrawError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; pointerId: number }>(undefined);
  const source = local ?? sourceUrl(frames[view.frame]!);
  const first = !local && view.frame === 0;
  const count = local ? 1 : frames.length;
  const image = loaded?.source === source ? loaded.image : undefined;
  const failed = (loaded?.source === source && !image) || drawError === source;
  useEffect(() => {
    const next = new Image();
    next.referrerPolicy = 'no-referrer';
    function discard() { window.clearTimeout(timeout); next.onload = null; next.onerror = null; next.removeAttribute('src'); }
    function fail() { discard(); setLoaded({ source }); if (first) onUnavailable(); }
    const timeout = window.setTimeout(fail, 15_000);
    next.onload = () => { window.clearTimeout(timeout); setLoaded({ source, image: next }); };
    next.onerror = fail;
    next.src = source;
    return discard;
  }, [source, first, onUnavailable]);
  useLayoutEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    try {
      const context = surface.getContext('2d');
      if (!context) throw Error();
      context.clearRect(0, 0, surface.width, surface.height);
      if (!image) return;
      if (!image.naturalWidth || !image.naturalHeight) throw Error();
      const scale = Math.min(surface.width / image.naturalWidth, surface.height / image.naturalHeight) * view.zoom;
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.filter = canvasFilter(view);
      context.drawImage(image, (surface.width - width) / 2 + view.panX, (surface.height - height) / 2 + view.panY, width, height);
      setDrawError('');
      if (first) onFirstFrame();
    } catch { setDrawError(source); if (first) onUnavailable(); }
  }, [image, view, first, source, onFirstFrame, onUnavailable]);
  const step = (amount: number) => dispatch({ type: 'frame', amount, count });
  return <section className="clinical-panel"><p>{local ? text('Local preview · only on this device', '本地预览 · 仅限本机') : text('Synthetic teaching frames', '合成教学关键帧')} · {view.frame + 1}/{count}</p>
    {failed && <p role="status">{text('Image unavailable. The signed text report remains available.', '图像不可用，仍可阅读已签发的文字报告。')}</p>}
    <canvas ref={canvas} width={640} height={400} className="study-canvas" hidden={failed} tabIndex={0} role="img" aria-label={text('Study frame, use the arrow keys to change frames', '检查关键帧，使用方向键翻帧')}
      onWheel={event => { if (event.deltaY) step(Math.sign(event.deltaY)); }} onKeyDown={event => {
        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); step(event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1); }
      }} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }; }}
      onPointerMove={event => { const last = drag.current; if (!last || event.pointerId !== last.pointerId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        dispatch({ type: 'pan', dx: (event.clientX - last.x) * 640 / rect.width, dy: (event.clientY - last.y) * 400 / rect.height });
        drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      }} onLostPointerCapture={() => { drag.current = undefined; }}/>
    {!image && !failed && <p role="status">{text('Loading frame…', '正在加载关键帧…')}</p>}
    <div className="cm-actions"><Button disabled={view.frame === 0} onClick={() => step(-1)}>{text('Previous frame', '上一帧')}</Button><Button disabled={view.frame + 1 >= count || !image} onClick={() => step(1)}>{text('Next frame', '下一帧')}</Button>
      <Button onClick={() => dispatch({ type: 'zoom', amount: 1.25 })}>{text('Zoom in', '放大')}</Button><Button onClick={() => dispatch({ type: 'zoom', amount: 0.8 })}>{text('Zoom out', '缩小')}</Button>
      <Button onClick={() => dispatch({ type: 'brightness', amount: 10 })}>{text('Brighter', '提高亮度')}</Button><Button onClick={() => dispatch({ type: 'brightness', amount: -10 })}>{text('Darker', '降低亮度')}</Button>
      <Button onClick={() => dispatch({ type: 'contrast', amount: 10 })}>{text('More contrast', '提高对比度')}</Button><Button onClick={() => dispatch({ type: 'contrast', amount: -10 })}>{text('Less contrast', '降低对比度')}</Button>
      <Button aria-pressed={view.inverted} onClick={() => dispatch({ type: 'invert' })}>{text('Invert', '反相')}</Button>
      {([[text('Pan left', '左移'), -24, 0], [text('Pan right', '右移'), 24, 0], [text('Pan up', '上移'), 0, -24], [text('Pan down', '下移'), 0, 24]] as const).map(([label, dx, dy]) => <Button key={label} onClick={() => dispatch({ type: 'pan', dx, dy })}>{label}</Button>)}
      <Button onClick={() => dispatch({ type: 'reset' })}>{text('Reset view', '复位视图')}</Button></div>
    <output>{text('Zoom', '缩放')} {Math.round(view.zoom * 100)}% · {text('Brightness', '亮度')} {view.brightness}% · {text('Contrast', '对比度')} {view.contrast}% · {text('Pan', '平移')} ({Math.round(view.panX)}, {Math.round(view.panY)})</output>
  </section>;
}
