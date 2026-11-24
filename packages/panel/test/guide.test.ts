import { CHAINS } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import {
  daysCovered,
  doneSteps,
  inPhantom,
  mcpCommand,
  nextStep,
  signLink,
  STEPS,
} from '../src/domain/guide.js'

const progress = (...done: string[]) =>
  ['passkey', 'vault', 'limit', 'deposit', 'agent', 'rules', 'shadow', 'live'].map((id) => ({
    id,
    done: done.includes(id),
  }))

describe('guided setup', () => {
  it('has nine steps, each with a reason', () => {
    expect(STEPS.map((step) => step.id)).toEqual([
      'passkey',
      'phantom',
      'vault',
      'limit',
      'deposit',
      'agent',
      'rules',
      'shadow',
      'live',
    ])
    expect(STEPS.every((step) => step.why.length > 20)).toBe(true)
  })

  it('resumes at the first step not done', () => {
    expect(nextStep(doneSteps(progress()))).toBe('passkey')
    expect(nextStep(doneSteps(progress('passkey')))).toBe('phantom')
    expect(nextStep(doneSteps(progress('passkey', 'vault', 'limit')))).toBe('deposit')
    expect(
      nextStep(
        doneSteps(
          progress('passkey', 'vault', 'limit', 'deposit', 'agent', 'rules', 'shadow', 'live'),
        ),
      ),
    ).toBeUndefined()
  })

  it('counts Phantom done once the vault is, and ignores ids it does not know', () => {
    const done = doneSteps([
      ...progress('vault'),
      { id: 'phantom', done: false },
      { id: 'other', done: true },
    ])
    expect([...done].sort()).toEqual(['phantom', 'vault'])
  })

  it('links the signing page on this origin, with the cluster and never a hot wallet', () => {
    const link = signLink('https://dm.example', CHAINS.solanaDevnet, {
      action: 'add-limit',
      multisig: 'M1',
    })
    expect(link).toBe('https://dm.example/sign/?action=add-limit&cluster=devnet&multisig=M1')
    expect(signLink('https://dm.example', CHAINS.base, { action: 'create' })).toBeUndefined()
  })

  it('opens a link inside the Phantom app', () => {
    expect(inPhantom('https://dm.example/sign/?action=create')).toBe(
      'https://phantom.app/ul/browse/https%3A%2F%2Fdm.example%2Fsign%2F%3Faction%3Dcreate?ref=https%3A%2F%2Fdm.example',
    )
  })

  it('counts whole days of the daily cap the balance covers', () => {
    expect(daysCovered('25000000', '10000000')).toBe(2n)
    expect(daysCovered('5', '10000000')).toBe(0n)
    expect(daysCovered('5', undefined)).toBeUndefined()
    expect(daysCovered('5', '0')).toBeUndefined()
  })

  it('gives a setup command that never carries the token', () => {
    const line = mcpCommand('https://dm.example', 'my-agent', [])
    expect(line).toContain('--guard-url https://dm.example --agent-id my-agent --check')
    expect(line).not.toMatch(/token/i)
  })

  it('names the chain with a vault, so a mainnet deployment is not sent to devnet', () => {
    const chains = [{ chain: CHAINS.robinhood }, { chain: CHAINS.solanaMainnet, vault: 'V1' }]
    expect(mcpCommand('https://dm.example', 'a', chains)).toContain(
      '--chain solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp --check',
    )
    expect(mcpCommand('https://dm.example', 'a', [{ chain: CHAINS.robinhood }])).toContain(
      `--chain ${CHAINS.robinhood} `,
    )
  })

  it('leaves out a chain id that is not safe on a command line', () => {
    expect(mcpCommand('https://dm.example', 'a', [{ chain: 'solana:x; rm -rf ~' }])).not.toContain(
      '--chain',
    )
  })
})
