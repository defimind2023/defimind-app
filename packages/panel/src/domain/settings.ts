export interface ChainSettings {
  chain: string
  rpcUrl?: string | undefined
  vault?: string | undefined
}

/**
 * Only what the owner changed. guard-core refuses with set_by_env any field the deployment's env
 * owns, and GET shows only the origin of an env RPC, so a field sent back unchanged would either be
 * refused or overwrite the real value. A field emptied is left out: SPEC has no way to clear one.
 */
export function changedSettings(
  before: ChainSettings[],
  form: { chain: string; rpcUrl: string; vault: string }[],
): ChainSettings[] {
  return form.flatMap(({ chain, rpcUrl, vault }) => {
    const was = before.find((c) => c.chain === chain)
    const rpc = rpcUrl.trim()
    const box = vault.trim()
    const entry = {
      ...(rpc && rpc !== (was?.rpcUrl ?? '') ? { rpcUrl: rpc } : {}),
      ...(box && box !== (was?.vault ?? '') ? { vault: box } : {}),
    }
    return Object.keys(entry).length === 0 ? [] : [{ chain, ...entry }]
  })
}
