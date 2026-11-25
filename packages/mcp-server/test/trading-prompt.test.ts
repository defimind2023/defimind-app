import { describe, expect, it } from 'vitest'
import { TRADING_AGENT_PROMPT } from '../src/tools/trading-prompt.js'
import { connect, fakeGuard } from './support.js'

describe('trading-agent prompt', () => {
  it('is listed, and returns one user message with the rules', async () => {
    const client = await connect(fakeGuard({}))
    const { prompts } = await client.listPrompts()
    expect(prompts.map((prompt) => prompt.name)).toEqual(['trading-agent'])
    const prompt = await client.getPrompt({ name: 'trading-agent' })
    expect(prompt.messages).toEqual([
      { role: 'user', content: { type: 'text', text: TRADING_AGENT_PROMPT } },
    ])
  })

  it('sets the safe defaults the quickstart promises', () => {
    expect(TRADING_AGENT_PROMPT).toContain('Quote before every swap')
    expect(TRADING_AGENT_PROMPT).toContain('If the quote lists any risk, do not buy')
    expect(TRADING_AGENT_PROMPT).toContain('NEW_TOKEN or MINT_AUTHORITY')
    expect(TRADING_AGENT_PROMPT).toContain(
      'never split a buy into smaller ones to get under a limit',
    )
    expect(TRADING_AGENT_PROMPT).toContain('Never retry it another way to avoid the wait')
    expect(TRADING_AGENT_PROMPT).toContain('This is not financial advice.')
  })

  it('names no token and promises no return', () => {
    expect(TRADING_AGENT_PROMPT).not.toMatch(/\b(SOL|JUP|BONK|WIF|ETH|BTC)\b/)
    expect(TRADING_AGENT_PROMPT).not.toMatch(/profit(?! or loss)|yield|moon|guaranteed|earn/i)
  })
})
