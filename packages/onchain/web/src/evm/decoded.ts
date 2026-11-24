import { ADDRESSES, USDC_DECIMALS } from '@defimind/shared'
import {
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { allowanceModuleAbi } from '../../../src/evm/safe.js'
import { read, REJECT, refuse, type Line } from '../decoded.js'
import { FALLBACK_HANDLER, MULTI_SEND_CALL_ONLY, PROXY_FACTORY, SAFE_L2, safeAbi } from './calls.js'

const abi = [
  ...safeAbi,
  ...allowanceModuleAbi,
  ...erc20Abi,
  ...parseAbi([
    'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
    'function multiSend(bytes transactions) payable',
    'function enableModule(address module)',
  ]),
]

/** The Allowance Module from the verified addresses in shared, built into the page: never from a link or a config. */
const MODULES = Object.values(ADDRESSES).flatMap((chain) =>
  chain.allowanceModule ? [chain.allowanceModule as Address] : [],
)
const known = (module: Address) => MODULES.some((m) => isAddressEqual(m, module))
const zero = (...values: (bigint | number)[]) => values.every((value) => BigInt(value) === 0n)

const units = (amount: bigint) =>
  `${formatUnits(amount, USDC_DECIMALS)} (${amount} base units at ${USDC_DECIMALS} decimals)`
const UNKNOWN = refuse(`A call this page cannot read${REJECT}`)

/**
 * What the call Phantom is about to send does, read from its bytes alone and not from the link or
 * whoever served the page: who gains a right or receives tokens, and how much. A field it does not
 * show must hold the value the page's own builders put there (calls.ts); anything else, like
 * anything it cannot read, is named as such, for the owner to reject.
 */
export function decodeEvm(to: Address, data: Hex): Line[] {
  let call
  try {
    call = decodeFunctionData({ abi, data })
  } catch {
    return [UNKNOWN]
  }
  const { functionName, args } = call
  switch (functionName) {
    case 'transfer': {
      const [recipient, amount] = args
      return [read(`Send ${units(amount)} of token ${to} to ${recipient}.`)]
    }
    case 'createProxyWithNonce': {
      const [singleton, initializer] = args
      if (!isAddressEqual(to, PROXY_FACTORY) || !isAddressEqual(singleton, SAFE_L2))
        return [UNKNOWN]
      const setup = decodeFunctionData({ abi: safeAbi, data: initializer })
      if (setup.functionName !== 'setup') return [UNKNOWN]
      const [owners, threshold, target, call, handler, paymentToken, payment, receiver] = setup.args
      // setup's to/data is a delegatecall the new Safe runs, and the payment a fee it pays out.
      const plain =
        isAddressEqual(target, zeroAddress) &&
        call === '0x' &&
        isAddressEqual(handler, FALLBACK_HANDLER) &&
        isAddressEqual(paymentToken, zeroAddress) &&
        payment === 0n &&
        isAddressEqual(receiver, zeroAddress)
      if (!plain) return [UNKNOWN]
      return [read(`Create a Safe owned by ${owners.join(', ')}, threshold ${threshold}.`)]
    }
    case 'execTransaction': {
      const [target, value, inner, operation, safeTxGas, baseGas, gasPrice, gasToken, refund] = args
      // A refund pays gasPrice × gas in gasToken to refundReceiver, out of the Safe.
      const noRefund =
        zero(safeTxGas, baseGas, gasPrice) &&
        isAddressEqual(gasToken, zeroAddress) &&
        isAddressEqual(refund, zeroAddress)
      if (!noRefund) return [UNKNOWN]
      if (value !== 0n) return [refuse(`The Safe sends ${value} wei of its own coin${REJECT}`)]
      const calls =
        operation === 1
          ? isAddressEqual(target, MULTI_SEND_CALL_ONLY)
            ? batch(to, inner)
            : [UNKNOWN]
          : inside(to, target, inner)
      return [read(`On Safe ${to}:`), ...calls]
    }
    default:
      return [UNKNOWN]
  }
}

/** A call the Safe makes itself. */
function inside(safe: Address, to: Address, data: Hex): Line[] {
  let call
  try {
    call = decodeFunctionData({ abi, data })
  } catch {
    return [UNKNOWN]
  }
  const { functionName, args } = call
  if (functionName === 'enableModule') {
    return isAddressEqual(to, safe) && known(args[0])
      ? [read(`Enable the Safe Allowance Module ${args[0]} on the Safe.`)]
      : [UNKNOWN]
  }
  // The module's own calls count only when they go to the known module.
  if (!known(to)) return [UNKNOWN]
  switch (functionName) {
    case 'addDelegate':
      return [read(`Make ${args[0]} a delegate of the Allowance Module.`)]
    case 'removeDelegate':
      return [read(`Remove ${args[0]} as a delegate of the Allowance Module, with its allowances.`)]
    case 'setAllowance': {
      const [delegate, token, amount, resetMin, resetBaseMin] = args
      if (resetBaseMin !== 0) return [UNKNOWN]
      return [
        read(`Let ${delegate} draw ${units(amount)} of token ${token}, every ${resetMin} minutes.`),
      ]
    }
    default:
      return [UNKNOWN]
  }
}

/** MultiSend's packed list: operation, to, value, data length, data. */
function batch(safe: Address, data: Hex): Line[] {
  const call = decodeFunctionData({ abi, data })
  if (call.functionName !== 'multiSend') return [UNKNOWN]
  const packed = call.args[0] as Hex
  const lines: Line[] = []
  for (let at = 0; at < size(packed);) {
    const operation = Number(slice(packed, at, at + 1))
    const to = getAddress(slice(packed, at + 1, at + 21))
    const value = BigInt(slice(packed, at + 21, at + 53))
    const length = Number(BigInt(slice(packed, at + 53, at + 85)))
    const inner = length ? slice(packed, at + 85, at + 85 + length) : '0x'
    lines.push(...(operation !== 0 || value !== 0n ? [UNKNOWN] : inside(safe, to, inner)))
    at += 85 + length
  }
  return lines
}
