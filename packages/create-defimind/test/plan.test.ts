import { CHAINS } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import type { Answers } from '../src/domain/answers.js'
import type { Source } from '../src/domain/env.js'
import {
  cloneCommand,
  dockerignoreGuard,
  finishTasks,
  flyTasks,
  pageTasks,
  pathsFor,
  proxyCommand,
  sshCreateAgent,
  type Setup,
} from '../src/domain/plan.js'
import { HOME, MULTISIG, REPO, RH_HOT, SAFE, SOL_HOT } from './fakes.js'

const answers: Answers = {
  prefix: 'acme',
  org: 'personal',
  region: 'gru',
  networks: ['solana-mainnet', 'robinhood-mainnet'],
  caps: { 'solana-mainnet': '20000000', 'robinhood-mainnet': '5000000' },
  preset: 'careful',
  telegram: true,
  ownerIds: '111,222',
  agentId: 'agent-1',
}

function setupFor(overrides: Partial<Setup> = {}): Setup {
  return {
    answers,
    paths: pathsFor(HOME, REPO, 'acme'),
    hot: { 'solana-mainnet': SOL_HOT, 'robinhood-mainnet': RH_HOT },
    vaults: { 'solana-mainnet': MULTISIG, 'robinhood-mainnet': SAFE },
    pageUrl: 'https://acme-signing-page.vercel.app',
    ...overrides,
  }
}

const env = (task: { command: { stdin?: unknown } }) => {
  const stdin = task.command.stdin as { env: [string, Source][] }
  return Object.fromEntries(stdin.env)
}

describe('flyTasks', () => {
  const tasks = flyTasks(setupFor())

  it('creates both apps and the volume, then stages the secrets, and deploys nothing', () => {
    expect(tasks.map((task) => [task.command.cmd, ...task.command.args].join(' '))).toEqual([
      'fly apps create acme-guard-core --org personal',
      'fly apps create acme-bot --org personal',
      'fly volumes create guard_data --size 1 --region gru --app acme-guard-core --yes',
      'fly secrets import --app acme-guard-core --stage',
      'fly secrets import --app acme-bot --stage',
    ])
  })

  it("gives guard-core its tokens, each chain's RPC and its hot key by reference", () => {
    expect(env(tasks[3]!)).toEqual({
      ADMIN_TOKEN: { secret: 'ADMIN_TOKEN', from: `${HOME}/.defimind/acme.env` },
      PUBLIC_URL: { value: 'https://acme-guard-core.fly.dev' },
      SETUP_CODE: { secret: 'SETUP_CODE', from: `${HOME}/.defimind/acme.env` },
      BOT_TOKEN: { secret: 'BOT_TOKEN', from: `${HOME}/.defimind/acme.env` },
      BOT_WEBHOOK_SECRET: { secret: 'BOT_WEBHOOK_SECRET', from: `${HOME}/.defimind/acme.env` },
      BOT_URL: { value: 'http://acme-bot.internal:8788' },
      SOLANA_CHAIN: { value: CHAINS.solanaMainnet },
      SOLANA_RPC_URL: { secret: 'SOLANA_RPC_URL', from: `${HOME}/.defimind/acme.env` },
      SOLANA_HOT_WALLET_KEYPAIR_JSON: {
        file: `${HOME}/.defimind/acme-solana-mainnet-hot.json`,
      },
      ROBINHOOD_CHAIN: { value: CHAINS.robinhood },
      ROBINHOOD_RPC_URL: { secret: 'ROBINHOOD_RPC_URL', from: `${HOME}/.defimind/acme.env` },
      ROBINHOOD_HOT_WALLET_KEY: { file: `${HOME}/.defimind/acme-robinhood-mainnet-hot.key` },
    })
  })

  it("gives the bot guard-core's bot token, never the admin one, and the public hot wallet", () => {
    const bot = env(tasks[4]!)
    expect(bot).not.toHaveProperty('GUARD_ADMIN_TOKEN')
    expect(bot['GUARD_BOT_TOKEN']).toEqual({ secret: 'BOT_TOKEN', from: expect.any(String) })
    expect(bot['OWNER_TELEGRAM_IDS']).toEqual({ value: '111,222' })
    expect(bot['SOLANA_HOT_WALLET_PUBKEY']).toEqual({ value: SOL_HOT })
    expect(bot['ROBINHOOD_CHAIN']).toEqual({ value: CHAINS.robinhood })
    expect(bot['ROBINHOOD_HOT_WALLET_ADDRESS']).toEqual({ value: RH_HOT })
  })

  it('leaves out a chain that was not chosen', () => {
    const solanaOnly = flyTasks(
      setupFor({
        answers: { ...answers, networks: ['solana-devnet'] },
        hot: { 'solana-devnet': SOL_HOT },
      }),
    )
    const guard = env(solanaOnly[3]!)
    expect(guard['SOLANA_CHAIN']).toEqual({ value: CHAINS.solanaDevnet })
    expect(Object.keys(guard).some((name) => name.startsWith('ROBINHOOD'))).toBe(false)
  })

  it('without Telegram makes one app, and gives guard-core none of the bot three (CR-017)', () => {
    const panelOnly = flyTasks(
      setupFor({ answers: { ...answers, telegram: false, ownerIds: undefined } }),
    )
    expect(panelOnly.map((task) => task.id)).toEqual([
      'fly:create:acme-guard-core',
      'fly:volume:acme-guard-core',
      'fly:secrets:acme-guard-core',
    ])
    const guard = env(panelOnly[2]!)
    expect(Object.keys(guard).filter((name) => name.startsWith('BOT_'))).toEqual([])
    expect(guard['PUBLIC_URL']).toEqual({ value: 'https://acme-guard-core.fly.dev' })
    expect(guard['SETUP_CODE']).toEqual({ secret: 'SETUP_CODE', from: expect.any(String) })
  })

  it('refuses a bot without the Telegram id that may use it', () => {
    expect(() => flyTasks(setupFor({ answers: { ...answers, ownerIds: undefined } }))).toThrow(
      /Telegram user id/,
    )
  })
})

describe('pageTasks', () => {
  it('links, sets each Production variable from stdin, then builds and deploys prebuilt', () => {
    const tasks = pageTasks(setupFor())
    expect(tasks.map((task) => task.id)).toEqual([
      'vercel:link',
      'vercel:env:SOLANA_HOT_WALLET_MAINNET',
      'vercel:env:SOLANA_MAINNET_RPC',
      'vercel:env:ROBINHOOD_HOT_WALLET_MAINNET',
      'vercel:pull',
      'vercel:build',
      'vercel:deploy',
    ])
    for (const task of tasks) {
      expect(task.command.cmd).toBe('npx')
      expect(task.command.args.slice(0, 2)).toEqual(['--yes', 'vercel'])
      expect(task.command.args.slice(-2)).toEqual(['--cwd', 'packages/onchain/web'])
      expect(task.command.cwd).toBe(REPO)
    }
    expect(tasks[0]!.command.args).toContain('acme-signing-page')
    expect(tasks[1]!.command.stdin).toEqual({ raw: { value: SOL_HOT } })
    expect(tasks[2]!.command.stdin).toEqual({
      raw: { secret: 'SOLANA_PAGE_RPC_URL', from: `${HOME}/.defimind/acme.env` },
    })
    expect(tasks[6]!.command.args).toEqual(
      expect.arrayContaining(['deploy', '--prebuilt', '--prod']),
    )
  })

  it('refuses before the hot wallets are known', () => {
    expect(() => pageTasks(setupFor({ hot: {} }))).toThrow(/hot wallet for Solana/)
  })
})

describe('finishTasks', () => {
  const tasks = finishTasks(setupFor())

  it('stages the vault addresses and the page, then deploys guard-core and the bot once each', () => {
    expect(tasks.map((task) => task.id)).toEqual([
      'fly:vault-secrets:acme-guard-core',
      'fly:vault-secrets:acme-bot',
      'fly:deploy:acme-guard-core',
      'fly:deploy:acme-bot',
    ])
    const signing = {
      SIGN_PAGE_URL: { value: 'https://acme-signing-page.vercel.app' },
      SQUADS_MULTISIG: { value: MULTISIG },
      ROBINHOOD_SAFE_ADDRESS: { value: SAFE },
    }
    // guard-core gets the page as well: the panel's kill links there.
    expect(env(tasks[0]!)).toEqual(signing)
    expect(env(tasks[1]!)).toEqual(signing)
  })

  it('without Telegram stages and deploys guard-core alone', () => {
    const panelOnly = finishTasks(
      setupFor({ answers: { ...answers, telegram: false, ownerIds: undefined } }),
    )
    expect(panelOnly.map((task) => task.id)).toEqual([
      'fly:vault-secrets:acme-guard-core',
      'fly:deploy:acme-guard-core',
    ])
    expect(env(panelOnly[0]!)['SIGN_PAGE_URL']).toEqual({
      value: 'https://acme-signing-page.vercel.app',
    })
  })

  it('deploys from the repository root with the generated config and the package Dockerfile', () => {
    expect(tasks[2]!.command).toEqual({
      cmd: 'fly',
      args: [
        'deploy',
        '.',
        '--config',
        `${HOME}/.defimind/fly/acme-guard-core.toml`,
        '--dockerfile',
        'packages/guard-core/Dockerfile',
        '--ha=false',
      ],
      cwd: REPO,
    })
    expect(tasks[3]!.command.args).toContain('packages/telegram-bot/Dockerfile')
  })

  it('refuses before the page and the vaults exist', () => {
    expect(() => finishTasks(setupFor({ pageUrl: undefined }))).toThrow(/signing page/)
    expect(() => finishTasks(setupFor({ vaults: {} }))).toThrow(/multisig for Solana/)
  })
})

describe('other commands', () => {
  it('guards against a .env in the build context as the deploy workflow does', () => {
    expect(dockerignoreGuard(setupFor())).toEqual({
      cmd: 'grep',
      args: ['-qx', '\\*\\*/.env', '.dockerignore'],
      cwd: REPO,
    })
  })

  it('proxies the private listener and falls back to create-agent.ts over ssh', () => {
    expect(proxyCommand('acme-guard-core').args).toEqual([
      'proxy',
      '18787:8787',
      '--app',
      'acme-guard-core',
    ])
    const ssh = sshCreateAgent('acme-guard-core', 'agent-1')
    expect(ssh.capture).toBe(true)
    expect(ssh.args.at(-1)).toBe(
      "sh -c 'cd /srv/defimind/packages/guard-core && node --import tsx src/scripts/create-agent.ts agent-1'",
    )
    expect(cloneCommand('/x/DefiMind').args).toEqual([
      'clone',
      'https://github.com/defimind2023/defimind-app.git',
      '/x/DefiMind',
    ])
  })
})
