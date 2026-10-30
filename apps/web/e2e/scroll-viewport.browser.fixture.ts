export function findScrollViewport(element: Element): HTMLElement {
  for (let parent: Element | null = element; parent !== null; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (parent instanceof HTMLElement && (overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent
  }
  throw new Error('The long content has no scrollable viewport')
}
