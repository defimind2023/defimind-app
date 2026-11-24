export const DAY_S = 86_400n

export interface Period {
  /** What can still be drawn before `resetsAtS`. */
  left: bigint
  resetsAtS: bigint
}

/**
 * Squads refills a limit lazily: on the first draw once more than a period has passed since
 * last_reset, it restores the cap and moves last_reset forward by whole periods
 * (spending_limit_use.rs). Until that draw the account still describes the old period, so this
 * says what the next draw will see.
 */
export function currentPeriod(
  limit: { cap: bigint; remaining: bigint; lastResetS: bigint },
  nowS: bigint,
): Period {
  const passed = nowS - limit.lastResetS
  if (passed > DAY_S) {
    const start = limit.lastResetS + (passed / DAY_S) * DAY_S
    return { left: limit.cap, resetsAtS: start + DAY_S }
  }
  return { left: limit.remaining, resetsAtS: limit.lastResetS + DAY_S }
}
