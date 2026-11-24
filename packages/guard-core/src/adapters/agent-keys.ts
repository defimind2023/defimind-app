import { isSvm, type ChainId } from '@defimind/shared'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { privateKeyToAddress } from 'viem/accounts'
import type { WalletKeys } from '../service/wallets.js'
import { readEvmKeyFile } from './keypair.js'
import { ensureKey, slug } from './keystore.js'
import { solanaAddress } from './public-keys.js'

/** An agent id is free text: one that is not a plain name gets a hash for its folder. */
function folder(agentId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(agentId)
    ? agentId
    : `id-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`
}

const envName = (agentId: string, chain: ChainId) =>
  `AGENT_WALLET_${agentId}_${slug(chain)}_FILE`.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/**
 * The agents' keys under dir/agents/<agentId>/<chain> (0600), or the file AGENT_WALLET_<AGENT>_
 * <CHAIN>_FILE names. Never logged, never returned: only the address leaves this module.
 */
export function agentKeys(
  dir: string,
  build: WalletKeys['build'],
  env: NodeJS.ProcessEnv = process.env,
): WalletKeys {
  return {
    async ensure(agentId, chain) {
      const svm = isSvm(chain)
      const file =
        env[envName(agentId, chain)] ??
        (await ensureKey(
          join(dir, 'agents', folder(agentId)),
          `${slug(chain)}${svm ? '.json' : ''}`,
          svm ? 'solana' : 'evm',
        ))
      const address = svm
        ? await solanaAddress(file)
        : privateKeyToAddress(await readEvmKeyFile(file))
      return { file, address }
    },
    build,
  }
}
