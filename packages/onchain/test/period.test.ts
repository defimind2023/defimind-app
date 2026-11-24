import { describe, expect, it } from 'vitest'
import { currentPeriod, DAY_S } from '../src/svm/period.js'

const lastResetS = 1_793_664_000n
const limit = { cap: 100n, remaining: 70n, lastResetS }
const at = (passed: bigint) => currentPeriod(limit, lastResetS + passed)

describe('currentPeriod', () => {
  it('keeps the account as it is within the period', () => {
    expect(at(3600n)).toEqual({ left: 70n, resetsAtS: lastResetS + DAY_S })
  })

  it('keeps it at exactly one period, as Squads refills only once more has passed', () => {
    expect(at(DAY_S)).toEqual({ left: 70n, resetsAtS: lastResetS + DAY_S })
  })

  it('refills one second later', () => {
    expect(at(DAY_S + 1n)).toEqual({ left: 100n, resetsAtS: lastResetS + 2n * DAY_S })
  })

  it('moves the reset forward by whole periods after idle days', () => {
    expect(at(2n * DAY_S + 3600n)).toEqual({ left: 100n, resetsAtS: lastResetS + 3n * DAY_S })
    expect(at(17n * DAY_S + 5n)).toEqual({ left: 100n, resetsAtS: lastResetS + 18n * DAY_S })
  })
})
