import { Auth } from './auth.js'
import type { AppConnect, AuthOptions } from './auth.js'
import { Client } from './client.js'
import { Workspace } from './workspace.js'

export * from './envelope.js'
export * from './error.js'
export { Client, childPath, resourceOf, stripQuery, filenameOf } from './client.js'
export type { ClientOptions, Query, QueryValue, RequestOptions, TokenSource } from './client.js'
export { Auth, AuthError, localStore, memoryStore } from './auth.js'
export type { AppConnect, AuthOptions, TokenStore, Tokens } from './auth.js'
export { subscribe, parseFrame, applyEvents } from './socket.js'
export type { SocketEvent, SubscribeHandlers, SubscribeOptions, Subscription } from './socket.js'
export { Workspace, Table, allPages, pageQuery } from './workspace.js'
export type { ExecuteResult, FilterOp, FilterValue, PageQuery, RowValues, TableSummary } from './workspace.js'

export type Morphcloud = {
  auth: Auth
  client: Client
  /** The app's workspace (`connect.workspacePath`). */
  workspace: Workspace
}

/**
 * Everything a workspace app needs, from its connect data:
 *
 * ```ts
 * const mc = createMorphcloud(connect)
 * await mc.auth.handleRedirect()
 * if (!mc.auth.isSignedIn()) await mc.auth.signIn()
 * const { data } = await mc.workspace.table('tasks').rows({ size: 50 })
 * ```
 */
export function createMorphcloud(connect: AppConnect, options: AuthOptions = {}): Morphcloud {
  const auth = new Auth(connect, options)
  const client = new Client({
    apiBaseUrl: connect.apiBaseUrl,
    token: () => auth.accessToken(),
    refresh: () => auth.refresh(),
    onSignedOut: () => auth.lost(),
    fetch: options.fetch,
  })
  return { auth, client, workspace: new Workspace(client, connect.workspacePath) }
}
