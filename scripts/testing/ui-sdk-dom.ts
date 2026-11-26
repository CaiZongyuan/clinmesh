Object.assign(HTMLElement.prototype, { showPopover() {}, hidePopover() {} });
Object.assign(Element.prototype, {
  getAnimations: () => [], scrollIntoView() {}, checkVisibility: () => true, getClientRects: () => [],
});
Object.assign(document, { elementFromPoint: () => null, elementsFromPoint: () => [] });
Object.assign(globalThis, {
  __UI_SDK_STRICT__: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '[popover] { display: block !important }' }));
