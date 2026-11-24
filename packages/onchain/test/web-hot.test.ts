import { describe, expect, it } from 'vitest'
import { NEEDS_OWN_PAGE, whichHot } from '../web/src/hot.js'

const same = (a: string, b: string) => a === b
const pick = (
  shared: string | undefined,
  named: string | undefined,
  kill = true,
  agents: string[] = [],
) => whichHot({ shared, agents }, named, kill, same, (key) => key)

describe('which hot wallet an action acts for', () => {
  it("acts for the build's own, and refuses a link naming another", () => {
    expect(pick('ours', undefined)).toEqual({ key: 'ours', fromLink: false })
    expect(pick('ours', 'ours', false)).toEqual({ key: 'ours', fromLink: false })
    expect(pick('ours', 'theirs')).toMatch(
      /names theirs as the hot wallet, but this page only acts for ours\./,
    )
  })

  it("acts for an agent's own wallet the link names, and for no wallet outside the build", () => {
    const agents = ['agent-1', 'agent-2']
    expect(pick('ours', 'agent-2', false, agents)).toEqual({ key: 'agent-2', fromLink: false })
    expect(pick('ours', undefined, false, agents)).toEqual({ key: 'ours', fromLink: false })
    expect(pick('ours', 'theirs', false, agents)).toMatch(
      /only acts for ours, agent-1, agent-2\. Do not sign/,
    )
  })

  it('needs the link to name the wallet when the build has agent wallets only', () => {
    expect(pick(undefined, 'agent-1', false, ['agent-1'])).toEqual({
      key: 'agent-1',
      fromLink: false,
    })
    expect(pick(undefined, undefined, false, ['agent-1'])).toMatch(/^This link names no hot wallet/)
  })

  it('takes it from the link on a build without one, for a kill only', () => {
    expect(pick(undefined, 'named')).toEqual({ key: 'named', fromLink: true })
    expect(pick(undefined, 'named', false)).toBe(NEEDS_OWN_PAGE)
    expect(pick(undefined, undefined)).toMatch(/^This kill link names no hot wallet/)
  })
})
