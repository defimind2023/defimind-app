import { appNames } from '../domain/answers.js'
import { formatUsd } from '../domain/amount.js'
import { tilde } from '../domain/env.js'
import { WizardError } from '../domain/errors.js'
import { agentTokenFile, sshCreateAgent, type Setup } from '../domain/plan.js'
import { createdAgent, presetPolicy, tokenFromScript } from '../domain/policy.js'
import type { State } from '../domain/state.js'
import { saveState, type Ctx } from './context.js'
import { ADMIN_BASE } from './doctor.js'

/**
 * The first agent, through the admin API on the proxy. It starts deny-all in shadow mode, and its
 * rules are the owner's to set in the panel: the admin token only tightens a policy (CR-022), so a
 * leaked one cannot open it.
 */
export async function firstAgent(ctx: Ctx, setup: Setup, state: State, token: string) {
  const { agentId } = setup.answers
  if (ctx.dry) {
    ctx.say(`  → POST ${ADMIN_BASE}/v1/admin/agents ${JSON.stringify({ agentId })}`)
    suggestRules(ctx, setup)
    return
  }
  if (!state.done.includes('agent')) {
    const created = await createAgent(ctx, setup, token)
    if (created === undefined) {
      ctx.say(`An agent named ${agentId} already exists, so its token and policy stay as they are.`)
      ctx.say('Make another one in the owner panel, under Agents.')
      return
    }
    const file = agentTokenFile(setup.paths, setup.answers.prefix, agentId)
    await ctx.files.write(file, `${created}\n`, { create: true })
    ctx.say(
      `✓ Agent ${agentId} created. Its token is in ${tilde(file, ctx.home)}, and nowhere else.`,
    )
    state.done.push('agent')
    await saveState(ctx, setup.paths, state)
  }
  suggestRules(ctx, setup)
}

/** The preset, for the owner to set in the panel with the passkey. */
function suggestRules(ctx: Ctx, setup: Setup) {
  const policy = presetPolicy(setup.answers)
  ctx.say(
    `It may pay nothing yet. In the owner panel, open Agents → ${setup.answers.agentId} → Rules`,
  )
  ctx.say(
    `and set: $${formatUsd(BigInt(policy.perTxMax))} per payment, $${formatUsd(BigInt(policy.dailyMax))} a day, your approval from $${formatUsd(BigInt(policy.approvalThreshold))},`,
  )
  ctx.say('then the API domains it may pay. It stays in shadow mode, signing nothing, until you')
  ctx.say('switch it to live there.')
}

/** The new agent's token, or undefined when an agent of that name exists already. */
async function createAgent(ctx: Ctx, setup: Setup, token: string): Promise<string | undefined> {
  const { agentId, prefix } = setup.answers
  const response = await ctx.http.request('POST', `${ADMIN_BASE}/v1/admin/agents`, {
    token,
    body: { agentId },
  })
  if (response.status === 409) {
    return undefined
  }
  if (response.status === 404) {
    ctx.say(
      'This guard-core predates POST /v1/admin/agents (SPEC v0.7): creating it on the machine.',
    )
    const printed = tokenFromScript(
      await ctx.run.run(sshCreateAgent(appNames(prefix).guard, agentId)),
    )
    if (printed === undefined) {
      throw new WizardError('ADMIN_API', 'create-agent.ts on the machine printed no token')
    }
    return printed
  }
  const created = createdAgent.safeParse(response.json)
  if (response.status >= 300 || !created.success) {
    throw new WizardError(
      'ADMIN_API',
      `guard-core answered ${response.status} to creating the agent`,
    )
  }
  return created.data.token
}
