import {
  AuthorityType,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createSetAuthorityInstruction,
  ExtensionType,
  getMintLen,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  SystemProgram,
  type PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { mintFacts } from '../src/svm/swap/mint.js'
import { chain } from './fixture.js'

const c = chain()
const authority = c.payer.publicKey
const other = Keypair.generate().publicKey

/** A mint made by the real token programs, with the given extensions set up before init. */
function mint(
  { program = TOKEN_PROGRAM_ID, freeze = false, revoked = false } = {},
  extensions: ExtensionType[] = [],
  setUp: (mint: PublicKey) => TransactionInstruction[] = () => [],
) {
  const key = Keypair.generate()
  const space = extensions.length ? getMintLen(extensions) : MINT_SIZE
  const result = c.run(
    [
      SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: key.publicKey,
        lamports: Number(c.svm.minimumBalanceForRentExemption(BigInt(space))),
        space,
        programId: program,
      }),
      ...setUp(key.publicKey),
      createInitializeMint2Instruction(
        key.publicKey,
        9,
        authority,
        freeze ? authority : null,
        program,
      ),
      ...(revoked
        ? [
            createSetAuthorityInstruction(
              key.publicKey,
              authority,
              AuthorityType.MintTokens,
              null,
              [],
              program,
            ),
          ]
        : []),
    ],
    key,
  )
  expect(String(result)).not.toMatch(/FailedTransaction/)
  const facts = mintFacts(key.publicKey, c.svm.getAccount(key.publicKey) as never)
  return facts
}

describe('what a mint says about the token', () => {
  it('reads a plain mint: its decimals, no risk', () => {
    expect(mint()).toEqual({
      decimals: 9,
      freezeAuthority: false,
      extensions: [],
      risks: [],
      mintAuthority: true,
    })
  })

  it('flags a freeze authority, which could lock the tokens', () => {
    expect(mint({ freeze: true }).risks).toEqual(['TOKEN_FREEZABLE'])
  })

  it.each([
    [
      'a transfer fee',
      ExtensionType.TransferFeeConfig,
      (m: PublicKey) => [
        createInitializeTransferFeeConfigInstruction(
          m,
          other,
          other,
          100,
          1n,
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
    ],
    [
      'a transfer hook',
      ExtensionType.TransferHook,
      (m: PublicKey) => [
        createInitializeTransferHookInstruction(m, other, other, TOKEN_2022_PROGRAM_ID),
      ],
    ],
    [
      'a permanent delegate',
      ExtensionType.PermanentDelegate,
      (m: PublicKey) => [
        createInitializePermanentDelegateInstruction(m, other, TOKEN_2022_PROGRAM_ID),
      ],
    ],
    [
      'no transfers at all',
      ExtensionType.NonTransferable,
      (m: PublicKey) => [createInitializeNonTransferableMintInstruction(m, TOKEN_2022_PROGRAM_ID)],
    ],
  ])('flags a Token-2022 mint with %s', (_case, extension, setUp) => {
    expect(mint({ program: TOKEN_2022_PROGRAM_ID }, [extension], setUp).risks).toEqual([
      'TOKEN_EXTENSION_RISK',
    ])
  })

  it('passes a Token-2022 mint whose only extension is a metadata pointer', () => {
    const facts = mint({ program: TOKEN_2022_PROGRAM_ID }, [ExtensionType.MetadataPointer], (m) => [
      createInitializeMetadataPointerInstruction(m, other, m, TOKEN_2022_PROGRAM_ID),
    ])
    expect(facts.risks).toEqual([])
  })

  it('reports whether the mint can still be inflated', () => {
    expect(mint().mintAuthority).toBe(true)
    expect(mint({ revoked: true }).mintAuthority).toBe(false)
  })

  it('refuses an account that is not a mint, or no account', () => {
    const key = Keypair.generate().publicKey
    expect(() => mintFacts(key, null)).toThrow(/^not_a_mint/)
    expect(() => mintFacts(authority, c.svm.getAccount(authority) as never)).toThrow(/^not_a_mint/)
  })
})
