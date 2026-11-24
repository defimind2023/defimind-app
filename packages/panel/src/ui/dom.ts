export type Child = Node | string | false | null | undefined

/**
 * Every string lands as a text node or an attribute value, never as markup: what guard-core relays
 * started with an agent or a 402 server.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value)
  }
  for (const child of children) {
    if (child) {
      node.append(child)
    }
  }
  return node
}

export function button(label: string, action: () => Promise<void>, kind = 'secondary') {
  const node = el('button', { type: 'button', class: kind }, label)
  node.addEventListener('click', () => {
    node.disabled = true
    void action().finally(() => {
      node.disabled = false
    })
  })
  return node
}

/** A label and its value, for the detail lists. */
export function row(label: string, value: Child) {
  return el('div', { class: 'row' }, el('dt', {}, label), el('dd', {}, value))
}

export function card(...children: Child[]) {
  return el('section', { class: 'card' }, ...children)
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** CSSOM, not a style attribute: the CSP's style-src blocks the latter, not the former. */
export function meter(percent: number) {
  const fill = el('i')
  fill.style.width = `${percent}%`
  return el('div', { class: 'meter', 'aria-hidden': 'true' }, fill)
}
