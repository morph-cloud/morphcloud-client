/**
 * Member sign-in for a workspace app: OAuth 2.1 authorization code with PKCE, a public client
 * with no secret. The settings are exactly what the workspace app's `connect` data gives
 * (`ApiWorkspaceAppConnect` in the backend) — copy that object into the app's config.
 */

/** The workspace app's connect data, as `…/ws/{slug}/app/{id}` serves it. Extra fields are ignored. */
export type AppConnect = {
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  revokeUrl: string
  apiBaseUrl: string
  workspacePath: string
  scope: string
}

export type Tokens = {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/** Where tokens live. The default is `localStorage`; pass `memoryStore()` to keep them in the page only. */
export type TokenStore = {
  get(): Tokens | null
  set(tokens: Tokens | null): void
}

export type AuthOptions = {
  store?: TokenStore
  /** Must be one of the app's return addresses exactly. Default: the page's origin + `/`. */
  redirectUri?: string
  fetch?: typeof fetch
}

const PKCE_KEY = 'morphcloud.pkce'

/**
 * False during server rendering (TanStack Start, Next.js…). There is no signed-in member on the
 * server: every token lives in the browser, so the server render always shows the signed-out state.
 */
const inBrowser = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined'
/** Refresh this long before the access token expires. */
const EARLY_MS = 30_000

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export class Auth {
  private readonly connect: AppConnect
  private readonly store: TokenStore
  private readonly redirectUriOption?: string
  private readonly fetchFn: typeof fetch
  private inFlight: Promise<boolean> | null = null
  private readonly listeners = new Set<(signedIn: boolean) => void>()

  constructor(connect: AppConnect, options: AuthOptions = {}) {
    this.connect = connect
    this.store = options.store ?? localStore(`morphcloud.tokens.${connect.clientId}`)
    this.redirectUriOption = options.redirectUri
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  get redirectUri(): string {
    if (this.redirectUriOption) return this.redirectUriOption
    if (!inBrowser()) throw new AuthError('The return address comes from the page: pass redirectUri when you use Auth on the server.')
    return `${window.location.origin}/`
  }

  /** Always false on the server. */
  isSignedIn(): boolean {
    return this.store.get() !== null
  }

  /** Called with `true` after a sign-in and `false` after a sign-out or a lost session. */
  onChange(listener: (signedIn: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Send the browser to the Morphcloud sign-in page. Inside an iframe (the Lovable editor
   * preview) the page opens in a new tab, because the sign-in page cannot load in a frame.
   */
  async signIn(): Promise<void> {
    if (!inBrowser()) throw new AuthError('signIn() runs in the browser only: call it from a click handler.')
    const verifier = randomString(32)
    const state = randomString(16)
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }))
    const url = new URL(this.connect.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.connect.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('scope', this.connect.scope)
    url.searchParams.set('code_challenge', await challengeOf(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    if (window.top && window.top !== window.self) window.open(url.toString(), '_blank')
    else window.location.assign(url.toString())
  }

  /**
   * Finish a sign-in when the page is the return address. Call it once on page load. Resolves
   * `true` when a sign-in just completed and `false` when the URL carries no sign-in result.
   * Removes the `code` and `state` from the address bar in both cases. On the server it does
   * nothing and resolves `false`: call it in the browser (for example in a `useEffect`).
   */
  async handleRedirect(): Promise<boolean> {
    if (!inBrowser()) return false
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const error = params.get('error')
    if (!code && !error) return false
    const clean = new URL(window.location.href)
    for (const k of ['code', 'state', 'error', 'error_description', 'iss']) clean.searchParams.delete(k)
    window.history.replaceState(window.history.state, '', clean.toString())

    const saved = readPkce()
    sessionStorage.removeItem(PKCE_KEY)
    if (error) throw new AuthError(params.get('error_description') ?? error)
    if (!saved || saved.state !== params.get('state')) {
      throw new AuthError('Sign-in could not be verified. Please try again.')
    }
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.connect.clientId,
      code: code!,
      redirect_uri: this.redirectUri,
      code_verifier: saved.verifier,
    })
    this.store.set(tokens)
    this.emit(true)
    return true
  }

  /** A valid access token, refreshed first when it is about to expire. `null` when signed out. */
  async accessToken(): Promise<string | null> {
    const tokens = this.store.get()
    if (!tokens) return null
    if (Date.now() < tokens.expiresAt - EARLY_MS) return tokens.accessToken
    return (await this.refresh()) ? this.store.get()?.accessToken ?? null : null
  }

  /**
   * Get a new access token with the refresh token. One refresh runs at a time — in this page,
   * and across tabs where the browser supports `navigator.locks` — because the server rotates
   * the refresh token and a second concurrent use of the old one fails.
   */
  refresh(): Promise<boolean> {
    if (!this.inFlight) {
      const seen = this.store.get()?.accessToken
      this.inFlight = this.withLock(() => this.doRefresh(seen)).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  /** Forget the tokens and revoke the refresh token. */
  async signOut(): Promise<void> {
    const tokens = this.store.get()
    this.store.set(null)
    this.emit(false)
    if (tokens?.refreshToken) {
      await this.fetchFn(this.connect.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken, client_id: this.connect.clientId }),
      }).catch(() => undefined)
    }
  }

  /** The session is gone (a refresh failed, or the server refused the new token). */
  lost(): void {
    if (!this.store.get()) return
    this.store.set(null)
    this.emit(false)
  }

  private async doRefresh(seen: string | undefined): Promise<boolean> {
    const before = this.store.get()
    if (!before?.refreshToken) return false
    // Another tab refreshed while this one waited for the lock: use its token.
    if (before.accessToken !== seen && Date.now() < before.expiresAt - EARLY_MS) return true
    try {
      const tokens = await this.tokenRequest({
        grant_type: 'refresh_token',
        client_id: this.connect.clientId,
        refresh_token: before.refreshToken,
      })
      this.store.set({ ...tokens, refreshToken: tokens.refreshToken ?? before.refreshToken })
      return true
    } catch (e) {
      if (e instanceof AuthError) this.lost()
      return false
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
    if (!locks) return fn()
    return locks.request(`morphcloud.refresh.${this.connect.clientId}`, fn) as Promise<T>
  }

  private async tokenRequest(body: Record<string, string>): Promise<Tokens> {
    let res: Response
    try {
      res = await this.fetchFn(this.connect.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      })
    } catch {
      // A network failure is not a lost session: keep the tokens and let the caller retry.
      throw new Error('Could not reach Morphcloud to sign in.')
    }
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
      | null
    if (!res.ok || !json?.access_token) {
      throw new AuthError(json?.error_description ?? json?.error ?? 'Sign-in failed. Please try again.')
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
    }
  }

  private emit(signedIn: boolean): void {
    for (const l of this.listeners) l(signedIn)
  }
}

/** Tokens in `localStorage`, under one key per app. On the server it holds nothing. */
export function localStore(key: string): TokenStore {
  return {
    get() {
      if (!inBrowser()) return null
      try {
        const raw = localStorage.getItem(key)
        return raw ? (JSON.parse(raw) as Tokens) : null
      } catch {
        return null
      }
    },
    set(tokens) {
      if (!inBrowser()) return
      try {
        if (tokens) localStorage.setItem(key, JSON.stringify(tokens))
        else localStorage.removeItem(key)
      } catch {
        // storage disabled: the session lasts for this page only
      }
    },
  }
}

export function memoryStore(): TokenStore {
  let tokens: Tokens | null = null
  return {
    get: () => tokens,
    set: (t) => {
      tokens = t
    },
  }
}

function readPkce(): { verifier: string; state: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null')
  } catch {
    return null
  }
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
