import type { Nav, NavError, NavMethod, NavResource } from './envelope.js'
import { MorphcloudError } from './error.js'

/** Returns the current access token, or nothing when no one is signed in. Called per request. */
export type TokenSource = () => string | null | undefined | Promise<string | null | undefined>

export type ClientOptions = {
  /** The API origin, e.g. `https://auth.morphcloud.com` (a workspace app's `apiBaseUrl`). */
  apiBaseUrl: string
  token?: TokenSource
  /**
   * Called once when a call answers 401 or 403. Resolve `true` when a new token is ready: the
   * call is then sent once more. `createMorphcloud` wires this to the OAuth refresh.
   */
  refresh?: () => Promise<boolean>
  /** Called when the session is gone for good (a 401 that a refresh could not fix). */
  onSignedOut?: () => void
  fetch?: typeof fetch
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[]
export type Query = Record<string, QueryValue>

export type RequestOptions = {
  query?: Query
  /** JSON-encoded, unless a top-level value is a `File`/`Blob`: then it goes as multipart. */
  body?: unknown
  signal?: AbortSignal
}

/**
 * The transport. Every method takes a Navigator path and returns the whole envelope, so the
 * app can read `control` (what it may do next) as well as `data`.
 *
 * - `request` never throws for an HTTP or network problem: the envelope's `error` says what
 *   went wrong (`status: 0` for the network). Only an abort re-throws.
 * - `get` / `post` / `put` / `patch` / `delete` throw a `MorphcloudError` instead.
 */
export class Client {
  readonly apiBaseUrl: string
  private readonly options: ClientOptions
  private readonly fetchFn: typeof fetch

  constructor(options: ClientOptions) {
    this.options = options
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  /** The absolute URL of a path. */
  url(path: string, query?: Query): string {
    const qs = toQueryString(query)
    return this.apiBaseUrl + toPath(path, this.apiBaseUrl) + (qs ? (path.includes('?') ? '&' : '?') + qs : '')
  }

  /** The current access token, as the token source gives it. */
  async token(): Promise<string | null> {
    return (await this.options.token?.()) ?? null
  }

  async request<T = unknown>(method: NavMethod, path: string, opts: RequestOptions = {}): Promise<Nav<T>> {
    let res = await this.send(method, path, opts)
    if ((res.status === 401 || res.status === 403) && this.options.refresh) {
      let refreshed = false
      try {
        refreshed = await this.options.refresh()
      } catch {
        refreshed = false
      }
      if (refreshed) res = await this.send(method, path, opts)
      if (res.status === 401) this.options.onSignedOut?.()
    }
    return res.envelope as Nav<T>
  }

  get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<Nav<T>> {
    return this.orThrow<T>('get', path, { query, signal })
  }

  post<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<Nav<T>> {
    return this.orThrow<T>('post', path, { ...opts, body })
  }

  put<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<Nav<T>> {
    return this.orThrow<T>('put', path, { ...opts, body })
  }

  patch<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<Nav<T>> {
    return this.orThrow<T>('patch', path, { ...opts, body })
  }

  delete<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<Nav<T>> {
    return this.orThrow<T>('delete', path, { ...opts, body })
  }

  /**
   * Download the file a downloadable path serves (`control.downloadable`). The filename comes
   * from the server's Content-Disposition when it sends one.
   */
  async download(path: string, query?: Query): Promise<{ blob: Blob; filename: string | null }> {
    const headers = await this.headers()
    const res = await this.fetchFn(this.url(path, { ...query, download: true }), { headers })
    if (!res.ok) {
      const envelope = await readEnvelope(res)
      throw new MorphcloudError(envelope.error ?? httpError(res.status), envelope)
    }
    return { blob: await res.blob(), filename: filenameOf(res.headers.get('Content-Disposition')) }
  }

  private async orThrow<T>(method: NavMethod, path: string, opts: RequestOptions): Promise<Nav<T>> {
    const envelope = await this.request<T>(method, path, opts)
    if (envelope.error) throw new MorphcloudError(envelope.error, envelope)
    return envelope
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra }
    const token = await this.token()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  private async send(method: NavMethod, path: string, opts: RequestOptions): Promise<{ status: number; envelope: Nav }> {
    const init: RequestInit = { method: method.toUpperCase(), signal: opts.signal }
    if (opts.body !== undefined) {
      if (hasFile(opts.body)) {
        init.body = toFormData(opts.body as Record<string, unknown>)
        init.headers = await this.headers()
      } else {
        init.body = JSON.stringify(opts.body)
        init.headers = await this.headers({ 'Content-Type': 'application/json' })
      }
    } else {
      init.headers = await this.headers()
    }
    let res: Response
    try {
      res = await this.fetchFn(this.url(path, opts.query), init)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      const message = e instanceof Error && e.message ? e.message : 'Network request failed'
      return { status: 0, envelope: { error: { status: 0, message } } }
    }
    const envelope = await readEnvelope(res)
    if (!res.ok && !envelope.error) envelope.error = httpError(res.status)
    return { status: res.status, envelope }
  }
}

/**
 * The `linkTo` of a named resource on an envelope. Throws when the envelope does not offer it,
 * or offers it but refuses this caller — with the server's reason.
 */
export function resourceOf(envelope: Nav, name: string): NavResource {
  const resource = envelope.control?.resource?.[name]
  if (!resource) {
    throw new MorphcloudError({ status: 404, message: `${envelope.path ?? 'This path'} has no "${name}" resource` }, envelope)
  }
  if (!resource.authorized) {
    throw new MorphcloudError({ status: 403, message: resource.message ?? `Not allowed: ${name}` }, envelope)
  }
  return resource
}

/**
 * A child of a Navigator path. This is the server's own rule — a child's path is its parent's
 * path, a slash, and the segment (see `NavigatorNodeControl.build`) — so it holds for static
 * routes (`row`, `cell`) and dynamic ones (a row id, a column slug).
 */
export function childPath(parent: string, ...segments: (string | number)[]): string {
  let path = stripQuery(parent).replace(/\/+$/, '')
  for (const s of segments) path += '/' + encodeURIComponent(String(s))
  return path
}

export function stripQuery(path: string): string {
  const i = path.indexOf('?')
  return i < 0 ? path : path.slice(0, i)
}

function toPath(path: string, apiBaseUrl: string): string {
  if (path.startsWith(apiBaseUrl)) path = path.slice(apiBaseUrl.length)
  return path.startsWith('/') ? path : '/' + path
}

export function toQueryString(query?: Query): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else params.append(key, String(value))
  }
  return params.toString()
}

async function readEnvelope(res: Response): Promise<Nav> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Nav) : { data: parsed }
  } catch {
    return res.ok ? { data: text } : { error: httpError(res.status) }
  }
}

function httpError(status: number): NavError {
  return { status, message: `Request failed (${status})` }
}

function isBinary(v: unknown): boolean {
  return typeof Blob !== 'undefined' && v instanceof Blob
}

function hasFile(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return Object.values(body).some(isBinary)
}

function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    if (isBinary(value)) form.append(key, value as Blob)
    else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return form
}

/** The filename in a Content-Disposition header; `filename*=UTF-8''…` wins over `filename=`. */
export function filenameOf(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header)
  return plain ? (plain[2] ?? plain[1] ?? '').trim() || null : null
}
