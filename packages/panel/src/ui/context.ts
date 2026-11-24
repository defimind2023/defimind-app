import type { OwnerApi } from '../adapters/api.js'
import type { Route } from '../domain/route.js'
import type { Child } from './dom.js'

/** What every screen gets: the API, navigation and the status line. */
export interface Context {
  api: OwnerApi
  go(route: Route, replace?: boolean): Promise<void>
  say(message: string, tone?: 'info' | 'done' | 'stop'): void
}

export type Screen = Promise<Child[]>
