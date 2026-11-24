import { spawn } from 'node:child_process'
import { devCheck } from './dev-check.js'

// `pnpm dev:all`: guard-core and mcp-server, and the Telegram bot only when guard-core names one.
const packages = ['@defimind/guard-core', '@defimind/mcp-server']
if (devCheck()) {
  packages.push('@defimind/telegram-bot')
} else {
  console.log('No BOT_URL in guard-core: running without the Telegram bot. Use the panel.')
}
const filters = packages.flatMap((name) => ['--filter', name])
const child = spawn('pnpm', ['--parallel', ...filters, 'run', 'dev'], {
  cwd: new URL('../../', import.meta.url),
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 1))
