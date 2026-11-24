import type { AgentSummary, DoctorCheck, Policy } from '@defimind/shared'
import { z } from 'zod'
import type { Tighten } from '../domain/policy.js'
import { type GuardClientOptions, requester } from './guard.js'

/**
 * What the owner reads and tightens from Telegram (CR-016): agents, policies and the doctor, on the
 * bot's own routes. Nothing here can create, allow, raise, go live or resume.
 */
export interface ControlClient {
  listAgents(): Promise<AgentSummary[]>
  /** False for an unknown agent. */
  revokeAgent(agentId: string): Promise<boolean>
  /** Undefined for an unknown agent. */
  policy(agentId: string): Promise<Policy | undefined>
  /** guard-core refuses a change that would loosen anything: 'loosen_in_panel'. */
  tighten(agentId: string, change: Tighten): Promise<Policy | 'loosen_in_panel'>
  doctor(): Promise<DoctorCheck[]>
}

const atomic = z.string().regex(/^(0|[1-9]\d*)$/)
const id = z.string().min(1).max(64)
const address = z.string().min(1).max(128)

export const policySchema = z.object({
  agentId: id,
  chains: z.array(z.string().min(3).max(64)).max(16),
  tokens: z.array(address).max(32),
  perTxMax: atomic,
  dailyMax: atomic,
  approvalThreshold: atomic,
  allowedRecipients: z.array(address).max(256),
  allowedDomains: z.array(z.string().min(1).max(253)).max(256),
  paused: z.boolean(),
  mode: z.enum(['live', 'shadow']).optional(),
  priceIncreaseMaxPct: z.number().optional(),
  maxPaymentsPerMinute: z.number().optional(),
  requireMandate: z.boolean().optional(),
})

const agents = z.object({
  agents: z
    .array(z.object({ agentId: id, paused: z.boolean(), mode: z.enum(['live', 'shadow']) }))
    .max(1000),
})

const checks = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        status: z.enum(['ok', 'warn', 'fail']),
        message: z.string().max(500),
        fix: z.string().max(500).optional(),
      }),
    )
    .max(64),
})

const refused = z.object({ error: z.literal('loosen_in_panel') })

export function httpControlClient(options: GuardClientOptions): ControlClient {
  const { bot, ok } = requester(options)
  const path = (agentId: string) => encodeURIComponent(agentId)

  return {
    async listAgents() {
      return agents.parse(await ok(await bot('GET', '/v1/bot/agents'))).agents
    },

    async revokeAgent(agentId) {
      const response = await bot('POST', `/v1/bot/agents/${path(agentId)}/revoke`, {})
      if (response.status === 404) {
        return false
      }
      await ok(response)
      return true
    },

    async policy(agentId) {
      const response = await bot('GET', `/v1/bot/policy/${path(agentId)}`)
      return response.status === 404 ? undefined : policySchema.parse(await ok(response))
    },

    async tighten(agentId, change) {
      const response = await bot('POST', `/v1/bot/policy/${path(agentId)}/tighten`, change)
      if (response.status === 403) {
        const body = refused.safeParse(await response.json().catch(() => undefined))
        if (body.success) {
          return 'loosen_in_panel'
        }
      }
      return policySchema.parse(await ok(response))
    },

    async doctor() {
      return checks.parse(await ok(await bot('GET', '/v1/bot/doctor'))).checks
    },
  }
}
