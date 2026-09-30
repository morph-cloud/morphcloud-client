import type { Nav, NavError } from './envelope.js'

export type MorphcloudErrorKind =
  | 'network'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'too_large'
  | 'rate_limited'
  | 'unavailable'
  | 'server'

/**
 * A refused or failed call. `message` is the server's own text — it is written for the person
 * using the app, so show it. `status` is the HTTP status, `0` when the request never reached
 * the server. `fieldErrors` maps a form field name to what is wrong with it.
 */
export class MorphcloudError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>
  readonly error: NavError
  readonly envelope: Nav | null

  constructor(error: NavError, envelope: Nav | null = null) {
    super(error.message)
    this.name = 'MorphcloudError'
    this.status = error.status
    this.fieldErrors = error.fieldErrors ?? {}
    this.error = error
    this.envelope = envelope
  }

  get kind(): MorphcloudErrorKind {
    const s = this.status
    if (s === 0) return 'network'
    if (s === 401) return 'unauthenticated'
    if (s === 403) return 'forbidden'
    if (s === 404) return 'not_found'
    if (s === 409) return 'conflict'
    if (s === 413) return 'too_large'
    if (s === 429) return 'rate_limited'
    if (s === 503) return 'unavailable'
    if (s >= 400 && s < 500) return 'invalid'
    return 'server'
  }
}

export function isMorphcloudError(e: unknown): e is MorphcloudError {
  return e instanceof MorphcloudError
}
