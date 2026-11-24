import { doneSteps, nextStep, STEPS, type StepId } from '../domain/guide.js'
import { href } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { card, el } from './dom.js'
import { stepBody } from './steps.js'

/** Every step, marked done or not; any of them can be opened again, in any order. */
function stepList(done: Set<StepId>, current: StepId) {
  return el(
    'ol',
    { class: 'steps' },
    ...STEPS.map((step) =>
      el(
        'li',
        { class: done.has(step.id) ? 'done' : '' },
        el(
          'a',
          {
            href: href({ name: 'guide', step: step.id }),
            ...(step.id === current ? { 'aria-current': 'step' } : {}),
          },
          step.title,
        ),
      ),
    ),
  )
}

/**
 * CR-019's guided setup. Progress is what guard-core finds in its own state and on the chain, so
 * the owner can leave at any step and come back to the first one that is not done.
 */
export async function guide(ctx: Context, step?: StepId): Screen {
  const done = doneSteps((await ctx.api.progress()).steps)
  const current = step ?? nextStep(done)
  if (current === undefined) {
    return [
      el('h1', {}, 'You are set up'),
      card(
        el('p', {}, 'Your agent pays within your rules, and asks you before anything above them.'),
        el('a', { href: href({ name: 'overview' }), class: 'button primary' }, 'Overview'),
        el('a', { href: href({ name: 'deposit' }), class: 'button' }, 'Add money'),
      ),
    ]
  }
  const index = STEPS.findIndex((s) => s.id === current)
  const { title, why } = STEPS[index]!
  const bar = el('progress', { max: String(STEPS.length), value: String(done.size) })
  return [
    el('h1', {}, 'Set up DefiMind'),
    el('p', { class: 'muted' }, `Step ${index + 1} of ${STEPS.length}`),
    bar,
    card(el('h2', {}, title), el('p', { class: 'why' }, why), ...(await stepBody(ctx, current))),
    el('details', {}, el('summary', {}, 'All steps'), stepList(done, current)),
  ]
}
