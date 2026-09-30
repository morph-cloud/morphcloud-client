import { describe, expect, it, vi } from 'vitest'
import { Auth, memoryStore } from '../src/auth.js'

const connect = {
  clientId: 'c1',
  authorizeUrl: 'https://auth.test/oauth/authorize',
  tokenUrl: 'https://auth.test/oauth/token',
  revokeUrl: 'https://auth.test/oauth/revoke',
  apiBaseUrl: 'https://auth.test',
  workspacePath: '/org/o/ws/w',
  scope: 'mcp:read mcp:write',
}

function tokenReply(access: string, refresh: string) {
  return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 900 }), { status: 200 })
}

describe('Auth', () => {
  it('runs one refresh for concurrent callers and keeps the rotated refresh token', async () => {
    const store = memoryStore()
    store.set({ accessToken: 'a0', refreshToken: 'r0', expiresAt: 0 })
    const fetch = vi.fn(async () => tokenReply('a1', 'r1'))
    const auth = new Auth(connect, { store, fetch })
    const [t1, t2] = await Promise.all([auth.accessToken(), auth.accessToken()])
    expect(t1).toBe('a1')
    expect(t2).toBe('a1')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.get()?.refreshToken).toBe('r1')
  })

  it('a refused refresh ends the session and tells listeners', async () => {
    const store = memoryStore()
    store.set({ accessToken: 'a0', refreshToken: 'r0', expiresAt: 0 })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    const auth = new Auth(connect, { store, fetch })
    const listener = vi.fn()
    auth.onChange(listener)
    expect(await auth.accessToken()).toBeNull()
    expect(store.get()).toBeNull()
    expect(listener).toHaveBeenCalledWith(false)
  })

  it('a network failure during refresh keeps the session', async () => {
    const store = memoryStore()
    store.set({ accessToken: 'a0', refreshToken: 'r0', expiresAt: 0 })
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const auth = new Auth(connect, { store, fetch })
    expect(await auth.refresh()).toBe(false)
    expect(store.get()?.refreshToken).toBe('r0')
  })
})

describe('Auth during server rendering (no window)', () => {
  it('is signed out, finishes no redirect, and refuses signIn with a clear message', async () => {
    const fetch = vi.fn()
    const auth = new Auth(connect, { fetch })
    expect(typeof window).toBe('undefined')
    expect(auth.isSignedIn()).toBe(false)
    expect(await auth.accessToken()).toBeNull()
    expect(await auth.handleRedirect()).toBe(false)
    await expect(auth.signIn()).rejects.toThrow('browser only')
    expect(fetch).not.toHaveBeenCalled()
  })
})
