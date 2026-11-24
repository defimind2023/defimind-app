import { isSolana } from '../domain/guide.js'
import { card, el } from './dom.js'

/**
 * CR-022, HIGH-3. Facts only: what one key behind every vault means, and what protects each kind of
 * vault. On Solana the vault's config authority is the owner's wallet, acting alone so the kill is
 * instant: added members do not bind it (ON-29). A Safe's threshold does. The vault's threshold and
 * signers join this once guard-core reads them (GC-64).
 */
const RISK =
  'One wallet controls every vault you make here. Whoever has its recovery phrase can empty each vault, past every daily limit.'

const SOLANA =
  'On Solana, your wallet can always act on the vault alone: that is what lets you stop it at once, and it means adding signers does not protect it. For larger balances, a hardware wallet is recommended: a Ledger connected through Phantom.'

const SAFE =
  'On Robinhood Chain or Base, a vault (Safe) that needs 2 of 3 signatures, one of them on a hardware key, does protect it. It is slower to stop in an emergency, because a second signer must sign too, and you then approve changes in Safe: the signing page here works with a one-signer vault.'

const SEPARATE =
  'Use a separate wallet for each chain, so one leaked phrase reaches one vault only.'

const advice = (chain: string) => (isSolana(chain) ? SOLANA : SAFE)

/** Where the guide creates the vault: the moment the owner picks the wallet that will control it. */
export function ownerKeyNote(chain: string) {
  return [el('p', { class: 'flag' }, RISK), el('p', { class: 'muted' }, advice(chain))]
}

export function ownerKeyCard(chains: string[]) {
  const kinds = [...new Set(chains.map(advice))]
  return card(
    el('h2', {}, 'Who controls your vaults'),
    el('p', { class: 'flag' }, RISK),
    ...kinds.map((line) => el('p', {}, line)),
    chains.length > 1 && el('p', {}, SEPARATE),
  )
}
