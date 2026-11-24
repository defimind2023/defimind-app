import {
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  parseAbi,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { allowanceModuleAbi } from '../src/evm/safe.js'
import {
  createData,
  depositData,
  enableData,
  FALLBACK_HANDLER,
  killData,
  MULTI_SEND_CALL_ONLY,
  preValidated,
  PROXY_FACTORY,
  SAFE_L2,
  safeAbi,
} from '../web/src/evm/calls.js'
import { decodeEvm as lines } from '../web/src/evm/decoded.js'

const owner = getAddress('0x0000000000000000000000000000000000000E0E')
const hot = getAddress('0x0000000000000000000000000000000000000B0b')
const safe = getAddress('0xE0f814d1D102ECa19737Fa20610ff2fA8226Bb20')
const module = getAddress('0xAA46724893dedD72658219405185Fb0Fc91e091C')
const usd = getAddress('0x7E955252E15c84f5768B83c41a71F9eba181802F')
const stranger = getAddress('0x00000000000000000000000000000000000a11ce')
const allowance = { module, hot, usd, cap: 5_000_000n }
const units = '5 (5000000 base units at 6 decimals)'
const decode = (to: Address, data: Hex) => lines(to, data).map((line) => line.text)
const UNKNOWN = 'A call this page cannot read: reject this transaction.'

const factoryAbi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)',
  'function multiSend(bytes transactions)',
  'function enableModule(address module)',
])

/** execTransaction as execByOwner builds it, with any of its fields changed. */
function exec(
  fields: Partial<Record<'to' | 'gas' | 'gasToken' | 'refund', Address | bigint>> = {},
) {
  const inner = encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: 'removeDelegate',
    args: [hot, true],
  })
  const gas = (fields.gas as bigint | undefined) ?? 0n
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [
      (fields.to as Address | undefined) ?? module,
      0n,
      inner,
      0,
      gas,
      gas,
      gas,
      (fields.gasToken as Address | undefined) ?? zeroAddress,
      (fields.refund as Address | undefined) ?? zeroAddress,
      preValidated(owner),
    ],
  })
}

/** createProxyWithNonce as createData builds it, with any setup field changed. */
function create(
  change: Partial<{
    singleton: Address
    to: Address
    data: Hex
    handler: Address
    payment: bigint
  }>,
) {
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [
      [owner],
      1n,
      change.to ?? zeroAddress,
      change.data ?? '0x',
      change.handler ?? FALLBACK_HANDLER,
      zeroAddress,
      change.payment ?? 0n,
      zeroAddress,
    ],
  })
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: 'createProxyWithNonce',
    args: [change.singleton ?? SAFE_L2, initializer, 1n],
  })
}

/** A MultiSend batch the Safe delegatecalls, of the given calls. */
function batch(calls: { to: Address; data: Hex }[]) {
  const packed = concat(
    calls.map(({ to, data }) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, to, 0n, BigInt(size(data)), data],
      ),
    ),
  )
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'multiSend', args: [packed] })
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [MULTI_SEND_CALL_ONLY, 0n, data, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })
}

const enableModule = (m: Address) =>
  encodeFunctionData({ abi: factoryAbi, functionName: 'enableModule', args: [m] })
const setAllowance = (resetBaseMin: number) =>
  encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: 'setAllowance',
    args: [hot, usd, 5_000_000n, 1440, resetBaseMin],
  })

describe('the EVM call, read from its bytes', () => {
  it('names the Safe, and who may draw, how much, in which token and how often, on enable', () => {
    expect(decode(safe, enableData(owner, safe, allowance, false))).toEqual([
      `On Safe ${safe}:`,
      `Enable the Safe Allowance Module ${module} on the Safe.`,
      `Make ${hot} a delegate of the Allowance Module.`,
      `Let ${hot} draw ${units} of token ${usd}, every 1440 minutes.`,
    ])
  })

  it('names the delegate the kill removes', () => {
    expect(decode(safe, killData(owner, module, hot))).toEqual([
      `On Safe ${safe}:`,
      `Remove ${hot} as a delegate of the Allowance Module, with its allowances.`,
    ])
  })

  it('names the recipient and amount of a deposit', () => {
    expect(decode(usd, depositData(safe, 5_000_000n))).toEqual([
      `Send ${units} of token ${usd} to ${safe}.`,
    ])
  })

  it('names the owners of a new Safe', () => {
    expect(decode(PROXY_FACTORY, createData(owner, 1n))).toEqual([
      `Create a Safe owned by ${owner}, threshold 1.`,
    ])
  })

  it('reads every call the page itself builds without a line it cannot read', () => {
    const built = [
      decode(PROXY_FACTORY, createData(owner, 1n)),
      decode(safe, enableData(owner, safe, allowance, false)),
      decode(safe, enableData(owner, safe, allowance, true)),
      decode(safe, killData(owner, module, hot)),
      decode(usd, depositData(safe, 1n)),
    ]
    expect(built.flat()).not.toContain(UNKNOWN)
  })

  it.each([
    ['a gas refund', exec({ gas: 1n })],
    ['a refund token', exec({ gasToken: usd })],
    ['a refund receiver', exec({ refund: stranger })],
    ['a module call to another module', exec({ to: stranger })],
  ])('refuses an execTransaction with %s', (_case, data) => {
    expect(decode(safe, data)).toContain(UNKNOWN)
  })

  it.each([
    ['another singleton', { singleton: stranger }],
    ['a setup delegatecall', { to: stranger, data: '0x1234' as Hex }],
    ['another fallback handler', { handler: stranger }],
    ['a setup payment', { payment: 1n }],
  ])('refuses a Safe creation with %s', (_case, change) => {
    expect(decode(PROXY_FACTORY, create(change))).toEqual([UNKNOWN])
  })

  it('refuses a creation sent anywhere but the proxy factory', () => {
    expect(decode(stranger, createData(owner, 1n))).toEqual([UNKNOWN])
  })

  it.each([
    ['enables an unknown module', [{ to: safe, data: enableModule(stranger) }]],
    ['enables the module on another Safe', [{ to: stranger, data: enableModule(module) }]],
    ['sets an allowance through another contract', [{ to: stranger, data: setAllowance(0) }]],
    ['sets an allowance with a reset base', [{ to: module, data: setAllowance(5) }]],
  ])('refuses a batch that %s', (_case, calls) => {
    expect(decode(safe, batch(calls))).toContain(UNKNOWN)
  })

  it('says it cannot read anything else', () => {
    expect(decode(safe, '0xdeadbeef')).toEqual([UNKNOWN])
  })
})
