export const initialViewport = { zoom: 1, panX: 0, panY: 0, brightness: 100, contrast: 100, inverted: false, frame: 0 };
export type Viewport = typeof initialViewport;
type Action = { type: 'pan'; dx: number; dy: number } | { type: 'zoom' | 'brightness' | 'contrast'; amount: number } | { type: 'frame'; amount: number; count: number } | { type: 'invert' | 'reset' };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function changeViewport(view: Viewport, action: Action): Viewport {
  switch (action.type) {
    case 'reset': return initialViewport;
    case 'invert': return { ...view, inverted: !view.inverted };
    case 'zoom': return { ...view, zoom: clamp(view.zoom * action.amount, 0.25, 8) };
    case 'pan': return { ...view, panX: clamp(view.panX + action.dx, -1200, 1200), panY: clamp(view.panY + action.dy, -1200, 1200) };
    case 'brightness': case 'contrast': return { ...view, [action.type]: clamp(view[action.type] + action.amount, 20, 300) };
    case 'frame': return { ...view, frame: clamp(view.frame + action.amount, 0, Math.max(0, action.count - 1)) };
  }
}

export function canvasFilter(view: Viewport) {
  return `brightness(${view.brightness}%) contrast(${view.contrast}%) invert(${view.inverted ? 1 : 0})`;
}
