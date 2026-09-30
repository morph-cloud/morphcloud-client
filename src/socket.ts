import { stripQuery } from './client.js'
import type { Client } from './client.js'
import type { Open } from './envelope.js'

/**
 * One live event. Collection sockets (rows) send `create` / `update` / `delete` with the row's
 * `id`; `update.body` holds only the fields that changed. `resync` carries no values: the
 * server could not send every event, so read the data again. Other sockets (the agent chat)
 * send their own frame types, which pass through unchanged.
 */
export type SocketEvent<B = Record<string, unknown>> = {
  type: Open<'create' | 'update' | 'delete' | 'resync'>
  id?: string | number
  body?: B
  [extra: string]: unknown
}

export type SubscribeHandlers<B = Record<string, unknown>> = {
  /** Every frame, as a list (a frame holds one event or many). */
  onEvents?: (events: SocketEvent<B>[]) => void
  /**
   * Read the data again now. Called after every open and reopen — the server does not replay
   * what happened while the socket was closed — and on every `resync` event.
   */
  onStale?: (reason: 'open' | 'reopen' | 'resync') => void
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void
}

export type Subscription = { close(): void }

export type SubscribeOptions = {
  /** Reconnect attempts after a close; the count starts again after each open. Default 10. */
  maxRetries?: number
  /** Heartbeat interval in ms. Default 50 000 — idle connections close after about 60 s. */
  heartbeatMs?: number
  WebSocket?: typeof WebSocket
}

/**
 * Listen to a path that has `control.connectable`. The socket reads the token again on every
 * attempt; with no token it does not connect. It reconnects after a drop and when a hidden tab
 * becomes visible again (a sleeping laptop closes sockets with no signal).
 *
 * The socket is authenticated once, when it opens. The server does not close it when the token
 * expires later; the next reconnect uses the current token.
 */
export function subscribe<B = Record<string, unknown>>(
  client: Client,
  path: string,
  handlers: SubscribeHandlers<B>,
  options: SubscribeOptions = {},
): Subscription {
  const Ws = options.WebSocket ?? globalThis.WebSocket
  const maxRetries = options.maxRetries ?? 10
  const heartbeatMs = options.heartbeatMs ?? 50_000
  const base = client.apiBaseUrl.replace(/^http/, 'ws') + '/sock' + stripQuery(path)

  let socket: WebSocket | null = null
  let closed = false
  let opened = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const connect = async () => {
    if (closed || socket) return
    const token = await client.token()
    if (closed || socket || !token) return
    handlers.onStatus?.('connecting')
    const ws = new Ws(`${base}?token=${encodeURIComponent(token)}`)
    let beat: ReturnType<typeof setInterval> | undefined
    socket = ws
    ws.onopen = () => {
      attempt = 0
      handlers.onStatus?.('open')
      handlers.onStale?.(opened ? 'reopen' : 'open')
      opened = true
      beat = setInterval(() => ws.readyState === Ws.OPEN && ws.send('beep'), heartbeatMs)
    }
    ws.onmessage = (msg) => {
      const events = parseFrame<B>(msg.data)
      if (events.length === 0) return
      handlers.onEvents?.(events)
      if (events.some((e) => e.type === 'resync')) handlers.onStale?.('resync')
    }
    ws.onclose = () => {
      clearInterval(beat)
      // A socket replaced after a tab came back: its successor owns the status and the retries.
      if (socket !== ws && socket !== null) return
      socket = null
      handlers.onStatus?.('closed')
      if (closed || attempt >= maxRetries) return
      attempt += 1
      retryTimer = setTimeout(connect, attempt * 3_000)
    }
  }

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || closed) return
    if (!socket || socket.readyState === Ws.CLOSED || socket.readyState === Ws.CLOSING) {
      socket = null
      attempt = 0
      clearTimeout(retryTimer)
      void connect()
    }
  }
  const hasDocument = typeof document !== 'undefined'
  if (hasDocument) document.addEventListener('visibilitychange', onVisible)

  void connect()

  return {
    close() {
      closed = true
      clearTimeout(retryTimer)
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible)
      socket?.close()
      socket = null
    },
  }
}

/** A frame is a JSON array of events (collections) or one object (the agent chat). */
export function parseFrame<B>(data: unknown): SocketEvent<B>[] {
  if (typeof data !== 'string') return []
  try {
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) return parsed.filter(isEvent) as SocketEvent<B>[]
    return isEvent(parsed) ? [parsed as SocketEvent<B>] : []
  } catch {
    return []
  }
}

function isEvent(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
}

/**
 * Apply row events to a list of rows: `create` adds the row at the front (or merges it when
 * the id is already there), `update` merges the changed fields, `delete` removes it. Ids are
 * compared as strings, because the same id can arrive as `42` or `"42"`. Returns a new list.
 */
export function applyEvents<R extends { rowId?: number | string }>(
  rows: readonly R[],
  events: readonly SocketEvent<Partial<R>>[],
  keyOf: (row: R) => string | number | undefined = (r) => r.rowId,
): R[] {
  let out = rows.slice()
  for (const e of events) {
    if (e.id === undefined) continue
    const id = String(e.id)
    const idx = out.findIndex((r) => String(keyOf(r)) === id)
    if (e.type === 'delete') {
      if (idx >= 0) out.splice(idx, 1)
    } else if (e.type === 'update' && e.body) {
      if (idx >= 0) out[idx] = { ...out[idx]!, ...e.body }
    } else if (e.type === 'create' && e.body) {
      if (idx >= 0) out[idx] = { ...out[idx]!, ...e.body }
      else out = [e.body as R, ...out]
    }
  }
  return out
}
