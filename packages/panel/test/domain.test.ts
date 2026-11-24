import { CHAINS, getAddress } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { chainName, networkOf } from '../src/domain/chains.js'
import { fromForm, toForm } from '../src/domain/form.js'
import {
  amountText,
  dollarsInput,
  formatUsd,
  meterPercent,
  parseDollars,
} from '../src/domain/money.js'
import { notification } from '../src/domain/notify.js'
import { chainRules, hostname, loosens, type Rules, vaulted } from '../src/domain/policy.js'
import { href, parseRoute, type Route } from '../src/domain/route.js'

describe('money', () => {
  it('formats atomic dollars with bigint, cents always', () => {
    expect(formatUsd('0')).toBe('$0.00')
    expect(formatUsd('1500000')).toBe('$1.50')
    expect(formatUsd('1234567890123')).toBe('$1,234,567.890123')
    expect(formatUsd('123456789012345678901234567890')).toBe(
      '$123,456,789,012,345,678,901,234.56789',
    )
  })

  it('refuses anything that is not an atomic amount', () => {
    for (const bad of ['', '-1', '1.5', '01', 'abc']) {
      expect(() => formatUsd(bad)).toThrow()
    }
  })

  it('parses dollars to atomic units', () => {
    expect(parseDollars('12.5')).toBe('12500000')
    expect(parseDollars(' $0.000001 ')).toBe('1')
    expect(parseDollars('7')).toBe('7000000')
    // An iPhone keypad in pt-BR types a comma.
    expect(parseDollars('2,00')).toBe('2000000')
    expect(parseDollars('2.00')).toBe('2000000')
    expect(parseDollars('2')).toBe('2000000')
    expect(parseDollars('0,5')).toBe('500000')
    expect(parseDollars('$1,250000')).toBe('1250000')
    for (const bad of [
      '',
      '-1',
      '1.1234567',
      '1,000',
      '1.234,56',
      '1,234.56',
      '2,',
      ',5',
      '1e6',
      '$',
      '.5',
    ]) {
      expect(parseDollars(bad)).toBeUndefined()
    }
  })

  it('round-trips through the dollar input', () => {
    expect(dollarsInput('1234500000')).toBe('1234.50')
    expect(parseDollars(dollarsInput('1234567891'))).toBe('1234567891')
  })

  it('shows dollars for the chain dollar only', () => {
    const usdc = getAddress(CHAINS.baseSepolia, 'usd')!
    expect(amountText({ chain: CHAINS.baseSepolia, token: usdc, amount: '2500000' })).toBe(
      '$2.50 USDC',
    )
    expect(amountText({ chain: CHAINS.baseSepolia, token: '0xdead', amount: '2500000' })).toBe(
      "2500000 base units of 0xdead (not this chain's dollar)",
    )
  })

  it('names known chains and shows unknown ones by id', () => {
    expect(chainName(CHAINS.solanaMainnet)).toBe('Solana')
    expect(chainName('eip155:1')).toBe('eip155:1')
  })
})

describe('routes', () => {
  const id = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab'
  const routes: Route[] = [
    { name: 'overview' },
    { name: 'login' },
    { name: 'enrol', code: 'a b&c' },
    { name: 'approval', id },
    { name: 'mandate', id },
    { name: 'agents' },
    { name: 'agent', id: 'bot/1' },
    { name: 'trade', id: 'bot/1' },
    { name: 'report' },
    { name: 'doctor' },
    { name: 'executions' },
    { name: 'passkeys' },
    { name: 'settings' },
    { name: 'kill' },
    { name: 'portfolio' },
    { name: 'setup' },
    { name: 'deposit' },
    { name: 'guide' },
    { name: 'guide', step: 'limit' },
  ]

  it('parses every href back to its route', () => {
    for (const route of routes) {
      const [path = '', hash = ''] = href(route).split('#')
      expect(parseRoute(path, hash && `#${hash}`)).toEqual(route)
    }
  })

  it('takes /panel without the slash as the overview', () => {
    expect(parseRoute('/panel')).toEqual({ name: 'overview' })
  })

  it('refuses what it does not know', () => {
    for (const path of [
      '/',
      '/panelx',
      '/panel/nope',
      '/panel/approvals/1',
      '/panel/a/b/c',
      '/panel/enrol',
      '/panel/agents/%E0',
      '/panel/start/nope',
    ]) {
      expect(parseRoute(path)).toEqual({ name: 'missing' })
    }
    expect(href({ name: 'missing' })).toBe('/panel/')
  })
})

describe('policy', () => {
  const before: Rules = {
    perTxMax: '1000000',
    dailyMax: '5000000',
    approvalThreshold: '2000000',
    chains: ['solana:a'],
    tokens: ['t'],
    allowedRecipients: ['r'],
    allowedDomains: ['api.example.com'],
    mode: 'shadow',
    requireMandate: true,
  }

  it('finds every loosening SPEC lists', () => {
    expect(loosens(before, { ...before, dailyMax: '5000001' })).toBe(true)
    expect(loosens(before, { ...before, tokens: ['t', 'u'] })).toBe(true)
    expect(loosens(before, { ...before, allowedDomains: ['b.example.com'] })).toBe(true)
    expect(loosens(before, { ...before, mode: 'live' })).toBe(true)
    expect(loosens(before, { ...before, requireMandate: false })).toBe(true)
  })

  it('also counts what guard-core counts: unpausing, a wider breaker or price margin', () => {
    expect(loosens({ ...before, paused: true }, { ...before, paused: false })).toBe(true)
    expect(loosens(before, { ...before, maxPaymentsPerMinute: 11 })).toBe(true)
    expect(loosens(before, { ...before, priceIncreaseMaxPct: 101 })).toBe(true)
    expect(loosens({ ...before, maxPaymentsPerMinute: 20 }, before)).toBe(false)
    expect(loosens(before, { ...before, maxPaymentsPerMinute: 10, priceIncreaseMaxPct: 50 })).toBe(
      false,
    )
    expect(loosens({ ...before, paused: false }, { ...before, paused: true })).toBe(false)
  })

  it('lets a tightening through without a passkey', () => {
    expect(loosens(before, before)).toBe(false)
    expect(loosens(before, { ...before, perTxMax: '1', allowedRecipients: [] })).toBe(false)
    expect(loosens({ ...before, mode: undefined }, { ...before, mode: 'shadow' })).toBe(false)
    expect(loosens({ ...before, mode: undefined }, { ...before, mode: 'live' })).toBe(false)
  })

  it('accepts hostnames only', () => {
    expect(hostname(' API.Example.com ')).toBe('api.example.com')
    for (const bad of ['localhost', 'https://a.com', 'a..com', '-a.com', 'a.com/x', 'a b.com']) {
      expect(hostname(bad)).toBeUndefined()
    }
  })

  it('turns the form into a policy and back', () => {
    const form = toForm(before)
    expect(form.perTxMax).toBe('1.00')
    expect(fromForm(before, form)).toEqual(before)
    const edited = fromForm(before, {
      ...form,
      dailyMax: '$10',
      allowedDomains: 'API.example.com\n\nb.example.com, b.example.com',
      allowedRecipients: ' r  s ',
      requireMandate: false,
    })
    expect(edited).toEqual({
      ...before,
      dailyMax: '10000000',
      allowedDomains: ['api.example.com', 'b.example.com'],
      allowedRecipients: ['r', 's'],
      requireMandate: false,
    })
  })

  it('says what is wrong with the form', () => {
    const form = toForm(before)
    expect(fromForm(before, { ...form, approvalThreshold: 'ten' })).toMatch(/^Ask me from/)
    expect(fromForm(before, { ...form, allowedDomains: 'https://x.com' })).toMatch(/not a hostname/)
    expect(fromForm(before, { ...form, allowedRecipients: 'x'.repeat(129) })).toMatch(/too long/)
  })
})

describe('notification', () => {
  const intentId = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab'

  it('opens the approval it is about', () => {
    expect(
      notification({ kind: 'approval', agentId: 'bot', chain: CHAINS.solanaMainnet, intentId }),
    ).toEqual({
      title: 'A payment waits for you',
      body: 'bot on Solana. Open the panel to see it.',
      tag: intentId,
      path: `/panel/approvals/${intentId}`,
    })
  })

  it('still shows something for a payload it does not know', () => {
    expect(notification(undefined)).toEqual({
      title: 'DefiMind',
      body: 'Open the panel to see it.',
      tag: 'defimind',
      path: '/panel/',
    })
    expect(notification({ kind: 'approval', intentId: '../../x' }).path).toBe('/panel/')
    expect(notification({ kind: 'toString' }).title).toBe('DefiMind')
    expect(notification({ kind: 'backup_failed' }).title).toBe('The database backup failed')
  })
})

describe('chain rules (PANEL-15)', () => {
  const deny = {
    chains: [] as string[],
    tokens: [] as string[],
    perTxMax: '0',
    dailyMax: '0',
    approvalThreshold: '0',
    allowedRecipients: [],
    allowedDomains: [],
  }
  const devnet = CHAINS.solanaDevnet
  const robinhood = CHAINS.robinhood

  it('opens a deny-all agent on the picked chains, each in its dollar', () => {
    const after = chainRules(deny, [devnet, robinhood], [devnet])
    expect(after.chains).toEqual([devnet])
    expect(after.tokens).toEqual([getAddress(devnet, 'usd')])
    expect(loosens(deny, after)).toBe(true)
  })

  it('takes a chain and its dollar away, and keeps what it does not manage', () => {
    const before = {
      ...deny,
      chains: [devnet, CHAINS.baseSepolia],
      tokens: [getAddress(devnet, 'usd')!, 'HandSetToken'],
    }
    const after = chainRules(before, [devnet, robinhood], [])
    expect(after.chains).toEqual([CHAINS.baseSepolia])
    expect(after.tokens).toEqual(['HandSetToken'])
    expect(loosens(before, after)).toBe(false)
  })

  it('counts only the chains with a vault as payable', () => {
    expect(vaulted([{ chain: devnet, vault: 'V' }, { chain: robinhood }])).toEqual([devnet])
  })
})

describe('overview header (PANEL-18)', () => {
  it('fills the meter in whole percent, in bigint, between 0 and 100', () => {
    expect(meterPercent('1000000', '20000000')).toBe(5)
    expect(meterPercent('0', '20000000')).toBe(0)
    expect(meterPercent('1', '20000000')).toBe(1)
    expect(meterPercent('30000000', '20000000')).toBe(100)
    expect(meterPercent('5', '0')).toBe(0)
    expect(meterPercent('123456789012345678901234567890', '246913578024691357802469135780')).toBe(
      50,
    )
  })

  it('names the network only when every chain agrees on it', () => {
    expect(networkOf([CHAINS.solanaMainnet, CHAINS.robinhood])).toBe('Mainnet')
    expect(networkOf([CHAINS.solanaMainnet, CHAINS.solanaDevnet])).toBe('Devnet')
    expect(networkOf([CHAINS.baseSepolia])).toBe('Testnet')
    expect(networkOf([])).toBeUndefined()
    expect(networkOf(['eip155:1'])).toBeUndefined()
  })
})
