if (typeof window !== "undefined" && typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.showPopover = function () {}
  HTMLElement.prototype.hidePopover = function () {}
  Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView = function () {}
  Element.prototype.checkVisibility = () => true
  document.elementFromPoint = () => null
  document.elementsFromPoint = () => []
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const style = document.createElement("style")
  style.textContent = "[popover]:not([hidden]) { display: block !important }"
  document.head.append(style)
}
