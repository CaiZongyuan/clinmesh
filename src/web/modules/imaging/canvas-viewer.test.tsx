// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { v7 } from 'uuid';
import { afterEach, expect, it, vi } from 'vitest';
import { createClinMeshUiAgent } from '../../../packages/ui-kit';
import { ReportReview } from './ReportReview';
import { canvasFilter, changeViewport, initialViewport } from './viewport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('bounds frame indices, zoom, pan and display filters and resets all transforms', () => {
  let view = changeViewport(initialViewport, { type: 'frame', amount: 20, count: 2 });
  view = changeViewport(view, { type: 'zoom', amount: 50 });
  view = changeViewport(view, { type: 'pan', dx: -2000, dy: 27 });
  view = changeViewport(view, { type: 'brightness', amount: -100 });
  view = changeViewport(view, { type: 'contrast', amount: 35 });
  view = changeViewport(view, { type: 'invert' });
  expect(view).toMatchObject({ frame: 1, zoom: 8, panX: -1200, panY: 27 });
  expect(canvasFilter(view)).toBe('brightness(20%) contrast(135%) invert(1)');
  expect(changeViewport(view, { type: 'reset' })).toEqual(initialViewport);
});

function review() {
  const images: HTMLImageElement[] = [];
  vi.stubGlobal('Image', function () {
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 256 }, naturalHeight: { value: 180 } });
    images.push(image);
    return image;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 400));
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => Object.assign(Object.create(CanvasRenderingContextPrototype), { drawImage, clearRect: vi.fn() }));
  const reportId = v7();
  const earlier = '2028-01-01T00:00:00Z';
  const request = vi.fn(async () => Response.json({ reportId, frames: ['one.png', 'two.png'] }));
  vi.stubGlobal('fetch', request);
  const acknowledge = vi.fn();
  const session = { workspaceId: v7(), epoch: v7(), roleId: 'reviewer', sessionVersion: 1 };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ReportReview kind="imaging" session={session} encounterId={v7()} language="en" canView busy={false} acknowledge={acknowledge} report={{
    id: reportId, version: 1, previousId: null, signedAt: earlier, acknowledged: null, frameCount: 2, requireFirstFrame: true,
    sections: { kind: 'imaging', findings: { en: 'Linear density', zh: '线状密度影' }, impression: { en: 'Scar', zh: '瘢痕' } },
  }}/></QueryClientProvider>);
  return { images, drawImage, acknowledge, request };
}
const CanvasRenderingContextPrototype = {};

it('loads frames only after opening, unlocks after an actual draw and keeps formal review behind human confirmation', async () => {
  const agent = createClinMeshUiAgent();
  const human = userEvent.setup();
  const { images, drawImage, request, acknowledge } = review();
  const confirmation = screen.getByRole('button', { name: 'Acknowledge this report version' });
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole('img')).toBeNull();
  await human.click(screen.getByRole('button', { name: 'Open image viewer · 2' }));
  await waitFor(() => expect(images).toHaveLength(1));
  expect(confirmation.hasAttribute('disabled')).toBe(true);
  await act(async () => { fireEvent.load(images[0]!); });
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(document.querySelector('canvas')?.hidden).toBe(false);
  expect(confirmation.hasAttribute('disabled')).toBe(false);
  expect((await agent.act({ steps: [{ ref: 'Zoom in', action: 'press' }] })).ok).toBe(true);
  expect(screen.getByText(/Zoom 125%/)).toBeDefined();
  fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowRight' });
  await waitFor(() => expect(images).toHaveLength(2));
  expect(images[1]!.src).toMatch(/two\.png$/);
  expect((await agent.act({ steps: [{ ref: 'Acknowledge this report version', action: 'press' }] })).ok).toBe(false);
  expect(acknowledge).not.toHaveBeenCalled();
  await human.click(confirmation);
  expect(acknowledge).toHaveBeenCalledWith('first-frame-rendered');
});

it.each(['load', 'draw'])('keeps structured text and explicitly acknowledges degraded review after a %s failure', async failure => {
  const human = userEvent.setup();
  const { images, drawImage, acknowledge } = review();
  await human.click(screen.getByRole('button', { name: 'Open image viewer · 2' }));
  await waitFor(() => expect(images).toHaveLength(1));
  if (failure === 'draw') { drawImage.mockImplementation(() => { throw Error('Canvas unavailable'); }); fireEvent.load(images[0]!); }
  else fireEvent.error(images[0]!);
  expect(await screen.findByText('Image unavailable. The signed text report remains available.')).toBeDefined();
  expect(screen.getByText('Linear density')).toBeDefined();
  expect(acknowledge).not.toHaveBeenCalled();
  await human.click(screen.getByRole('button', { name: 'Acknowledge text report with images unavailable' }));
  expect(acknowledge).toHaveBeenCalledWith('frames-unavailable');
});
