import type { PayIntent } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { checkSimulation } from '../src/domain/simulation.js'

const intent = { token: 'USDC', amount: '1000000' } as PayIntent
const run = (...balanceChanges: { token: string; delta: string }[]) =>
  checkSimulation({ summary: '', balanceChanges }, intent)

describe('checkSimulation', () => {
  it('accepts a loss of exactly the amount', () => {
    expect(run({ token: 'USDC', delta: '-1000000' })).toEqual([])
  })

  it('accepts no reported change at all', () => {
    expect(run()).toEqual([])
  })

  it('ignores other tokens, such as the fee in the native token', () => {
    expect(run({ token: 'SOL', delta: '-5000' }, { token: 'USDC', delta: '-1000000' })).toEqual([])
  })

  it('refuses a loss beyond the amount, even split across entries', () => {
    expect(run({ token: 'USDC', delta: '-1000000' }, { token: 'USDC', delta: '-1' })).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })

  it.each(['1.5', '-', '', '0x10', '--1'])('fails on an unreadable delta %j', (delta) => {
    expect(run({ token: 'USDC', delta })).toEqual(['SIM_FAILED'])
  })
})

describe('checkSimulation for a swap (CR-021)', () => {
  const swap = {
    token: 'USDC',
    amount: '1000000',
    swap: { tokenOut: 'BONK', minAmountOut: '500' },
  } as PayIntent
  const run = (...balanceChanges: { token: string; delta: string }[]) =>
    checkSimulation({ summary: '', balanceChanges }, swap)

  it('accepts at least the minimum in for at most the amount out', () => {
    expect(run({ token: 'USDC', delta: '-1000000' }, { token: 'BONK', delta: '500' })).toEqual([])
  })

  it('refuses less than the minimum in, or nothing in at all', () => {
    expect(run({ token: 'USDC', delta: '-1000000' }, { token: 'BONK', delta: '499' })).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
    expect(run({ token: 'USDC', delta: '-1000000' })).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('refuses more out than the amount, whatever comes in', () => {
    expect(run({ token: 'USDC', delta: '-1000001' }, { token: 'BONK', delta: '900' })).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })
})
