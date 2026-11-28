if (typeof window !== 'undefined' && typeof HTMLElement !== 'undefined') {
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
  if (!('inert' in HTMLElement.prototype)) {
    const inertAriaHidden = new WeakSet<HTMLElement>()
    Object.defineProperty(HTMLElement.prototype, 'inert', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('inert')
      },
      set(this: HTMLElement, value: boolean) {
        if (value) {
          this.setAttribute('inert', '')
          if (!this.hasAttribute('aria-hidden')) {
            this.setAttribute('aria-hidden', 'true')
            inertAriaHidden.add(this)
          }
        } else {
          this.removeAttribute('inert')
          if (inertAriaHidden.delete(this)) {
            this.removeAttribute('aria-hidden')
          }
        }
      },
    })
  }
  const style = document.createElement('style')
  style.textContent = '[popover]:not([hidden]) { display: block !important } [data-ui-sdk-announcer]:empty { display: none }'
  document.head.append(style)
}
