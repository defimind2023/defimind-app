import { USDC_DECIMALS } from '@defimind/shared'
import { formatUnits } from '../../src/svm/transfer.js'
import { amountProblem, parseAmount } from './amount.js'
import type { Line } from './decoded.js'

const app = document.getElementById('app')!

export function show(title: string, lines: string[], tone: 'info' | 'stop' | 'done' = 'info') {
  app.replaceChildren()
  app.dataset['state'] = tone
  const heading = document.createElement('h1')
  heading.textContent = title
  app.append(heading)
  for (const line of lines) {
    const p = document.createElement('p')
    p.textContent = line
    app.append(p)
  }
}

export function button(label: string, action: () => void) {
  const element = document.createElement('button')
  element.textContent = label
  element.addEventListener('click', action, { once: true })
  app.append(element)
}

export function link(label: string, href: string) {
  const element = document.createElement('a')
  element.href = href
  element.textContent = label
  app.append(element)
}

/** After the wallet has sent it: read the chain until the change is there, for about a minute. */
export async function waitFor(plan: {
  after: string
  landed: () => Promise<string[] | undefined>
}) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await plan.landed()
    if (result) {
      show(plan.after, result, 'done')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  show(
    'Not confirmed yet',
    ['The change is not on the chain yet. Run status before trying again.'],
    'stop',
  )
}

/**
 * Asks the owner for an amount, in whole dollars, and resolves with it in base units once it is one
 * the page can use. The page then shows what the transaction carries before Phantom asks to sign.
 */
export function askAmount(ask: {
  title: string
  lines: string[]
  label: string
  symbol: string
  max?: bigint
  /** From the link, for the owner to confirm or change: never used without the owner's say. */
  initial?: bigint
}): Promise<bigint> {
  show(ask.title, ask.lines)
  const form = document.createElement('form')
  const label = document.createElement('label')
  label.textContent = `${ask.label} (${ask.symbol})`
  const input = document.createElement('input')
  input.name = 'amount'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.required = true
  if (ask.initial !== undefined) input.value = formatUnits(ask.initial, USDC_DECIMALS)
  label.append(input)
  const problem = document.createElement('p')
  problem.setAttribute('role', 'alert')
  const submit = document.createElement('button')
  submit.textContent = 'Continue'
  form.append(label, problem, submit)
  app.append(form)
  input.focus()
  return new Promise((resolve) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const found = amountProblem(input.value, ask.max, ask.symbol)
      problem.textContent = found ?? ''
      if (!found) resolve(parseAmount(input.value)!)
    })
  })
}

/**
 * What the transaction itself does, in large text, under the page's own summary: read from its
 * bytes, so the owner has something not from the link or the server to hold against Phantom's screen.
 */
export function decoded(lines: Line[]) {
  const section = document.createElement('section')
  section.className = 'decoded'
  const heading = document.createElement('h2')
  heading.textContent = 'What this transaction does, read from its bytes'
  const list = document.createElement('ol')
  for (const line of lines) {
    const item = document.createElement('li')
    item.textContent = line.text
    list.append(item)
  }
  section.append(heading, list)
  app.append(section)
}
