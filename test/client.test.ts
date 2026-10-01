import { describe, expect, it, vi } from 'vitest'
import { Client, childPath, filenameOf, trimTrailingSlashes } from '../src/client.js'
import { MorphcloudError } from '../src/error.js'
import { applyEvents, parseFrame } from '../src/socket.js'
import { Table, pageQuery } from '../src/workspace.js'

function reply(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Client', () => {
  it('sends the bearer token and returns the whole envelope', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      reply(200, { path: '/x', data: { a: 1 }, control: { resource: {}, action: {} } }))
    const client = new Client({ apiBaseUrl: 'https://api.test/', token: () => 't1', fetch })
    const nav = await client.get('/x', { page: 0, 'filter:status': ['a', 'b'], size: undefined })
    expect(nav.data).toEqual({ a: 1 })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.test/x?page=0&filter%3Astatus=a&filter%3Astatus=b')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer t1')
  })

  it('throws the server message and field errors', async () => {
    const fetch = vi.fn(async () => reply(400, { error: { status: 400, message: 'Title is required', fieldErrors: { title: 'required' } } }))
    const client = new Client({ apiBaseUrl: 'https://api.test', fetch })
    const e = await client.post('/x', {}).catch((x) => x)
    expect(e).toBeInstanceOf(MorphcloudError)
    expect(e.message).toBe('Title is required')
    expect(e.kind).toBe('invalid')
    expect(e.fieldErrors).toEqual({ title: 'required' })
  })

  it('request() never throws: a network failure is status 0', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = new Client({ apiBaseUrl: 'https://api.test', fetch })
    const nav = await client.request('get', '/x')
    expect(nav.error).toEqual({ status: 0, message: 'Failed to fetch' })
  })

  it('refreshes once on 401 and retries', async () => {
    let token = 'old'
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
      (init!.headers as Record<string, string>).Authorization === 'Bearer new' ? reply(200, { data: 1 }) : reply(401, { error: { status: 401, message: 'no' } }))
    const refresh = vi.fn(async () => {
      token = 'new'
      return true
    })
    const onSignedOut = vi.fn()
    const client = new Client({ apiBaseUrl: 'https://api.test', token: () => token, refresh, onSignedOut, fetch })
    expect((await client.get('/x')).data).toBe(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('a 403 that survives the refresh is a refusal, not a lost session', async () => {
    const fetch = vi.fn(async () => reply(403, { error: { status: 403, message: 'Members only' } }))
    const onSignedOut = vi.fn()
    const client = new Client({ apiBaseUrl: 'https://api.test', token: () => 't', refresh: async () => true, onSignedOut, fetch })
    const e = await client.get('/x').catch((x) => x)
    expect(e.kind).toBe('forbidden')
    expect(e.message).toBe('Members only')
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('a 401 that survives the refresh signs out', async () => {
    const fetch = vi.fn(async () => reply(401, { error: { status: 401, message: 'no' } }))
    const onSignedOut = vi.fn()
    const client = new Client({ apiBaseUrl: 'https://api.test', token: () => 't', refresh: async () => false, onSignedOut, fetch })
    await client.get('/x').catch(() => undefined)
    expect(onSignedOut).toHaveBeenCalledTimes(1)
  })

  it('a non-JSON error page becomes an envelope error', async () => {
    const fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    const client = new Client({ apiBaseUrl: 'https://api.test', fetch })
    const nav = await client.request('get', '/x')
    expect(nav.error?.status).toBe(502)
  })

  it('sends multipart when a value is a Blob', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => reply(200, { data: null }))
    const client = new Client({ apiBaseUrl: 'https://api.test', fetch })
    await client.put('/cell', { value: new Blob(['x']), tz: 'UTC' })
    const init = fetch.mock.calls[0]![1]!
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})

describe('paths and queries', () => {
  it('trimTrailingSlashes removes only the trailing slashes, in linear time', () => {
    expect(trimTrailingSlashes('https://api.example.com///')).toBe('https://api.example.com')
    expect(trimTrailingSlashes('/a/b')).toBe('/a/b')
    expect(trimTrailingSlashes('///')).toBe('')
    expect(trimTrailingSlashes('')).toBe('')
    const long = '/'.repeat(200_000) + 'x'
    const start = Date.now()
    expect(trimTrailingSlashes(long)).toBe(long)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('childPath follows the server rule and drops a query', () => {
    expect(childPath('/org/a/ws/b?x=1', 'table', 'my-table')).toBe('/org/a/ws/b/table/my-table')
  })

  it('pageQuery writes filters with and without an operator', () => {
    expect(pageQuery({ size: 10, filter: { title: 'a', priority: ['1', '2'], dueDate: { op: 'is_null' }, n: { op: 'greater_than', value: 3 } } })).toEqual({
      page: undefined,
      size: 10,
      sortField: undefined,
      sortDirection: undefined,
      'filter:title': 'a',
      'filter:priority': ['1', '2'],
      'filter:dueDate:is_null': '',
      'filter:n:greater_than': 3,
    })
  })

  it('filenameOf prefers the UTF-8 form', () => {
    expect(filenameOf(`attachment; filename="a.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`)).toBe('résumé.csv')
    expect(filenameOf('attachment; filename="a b.csv"')).toBe('a b.csv')
    expect(filenameOf(null)).toBeNull()
  })
})

describe('Table', () => {
  it('writes a cell by its slug when given the camelCase key', async () => {
    const fetch = vi.fn(async (u: string | URL | Request, _i?: RequestInit) =>
      String(u).includes('/row?')
        ? reply(200, { data: { content: [], totalElements: 0, totalPages: 0, request: { page: 0, size: 1 }, columns: [{ nameCamel: 'dueDate', nameSlug: 'due-date' }] } })
        : reply(200, { data: {} }))
    const table = new Table(new Client({ apiBaseUrl: 'https://api.test', fetch }), '/ws/w/table/tasks')
    await table.setCell(7, 'dueDate', '2026-10-01')
    const [url, init] = fetch.mock.calls[1]!
    expect(url).toBe('https://api.test/ws/w/table/tasks/row/7/cell/due-date')
    expect(init!.method).toBe('PUT')
    expect(init!.body).toBe(JSON.stringify({ value: '2026-10-01' }))
  })

  it('uploads a Blob to a file cell as the multipart part "file" (the server refuses any other name)', async () => {
    const fetch = vi.fn(async (u: string | URL | Request, _i?: RequestInit) =>
      String(u).includes('/row?')
        ? reply(200, { data: { content: [], totalElements: 0, totalPages: 0, request: { page: 0, size: 1 }, columns: [{ nameCamel: 'file', nameSlug: 'file' }] } })
        : reply(200, { data: {} }))
    const table = new Table(new Client({ apiBaseUrl: 'https://api.test', fetch }), '/ws/w/table/docs')
    await table.setCell(5, 'file', new Blob(['%PDF'], { type: 'application/pdf' }))
    const [url, init] = fetch.mock.calls[1]!
    expect(url).toBe('https://api.test/ws/w/table/docs/row/5/cell/file')
    const form = init!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect(form.get('value')).toBeNull()
  })

  it('downloadFile asks the file cell for its download', async () => {
    const fetch = vi.fn(async (u: string | URL | Request, _i?: RequestInit) =>
      String(u).includes('/row?')
        ? reply(200, { data: { content: [], totalElements: 0, totalPages: 0, request: { page: 0, size: 1 }, columns: [{ nameCamel: 'file', nameSlug: 'file' }] } })
        : new Response('bytes', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="a.pdf"' } }))
    const table = new Table(new Client({ apiBaseUrl: 'https://api.test', fetch }), '/ws/w/table/docs')
    const { filename } = await table.downloadFile(5, 'file')
    expect(fetch.mock.calls[1]![0]).toBe('https://api.test/ws/w/table/docs/row/5/cell/file?download=true')
    expect(filename).toBe('a.pdf')
  })

  it('execute sends one payload, or an array for many rows', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => reply(200, { data: {} }))
    const table = new Table(new Client({ apiBaseUrl: 'https://api.test', fetch }), '/ws/w/table/tasks')
    await table.execute(3)
    await table.execute([3, 4])
    expect(fetch.mock.calls[0]![1]!.body).toBe('{"rowId":3}')
    expect(fetch.mock.calls[1]![1]!.body).toBe('[{"rowId":3},{"rowId":4}]')
  })
})

describe('socket frames', () => {
  it('parses an array frame and a single-object frame; drops junk', () => {
    expect(parseFrame('[{"type":"update","id":1,"body":{"a":1}}]')).toHaveLength(1)
    expect(parseFrame('{"type":"delta","text":"hi"}')).toEqual([{ type: 'delta', text: 'hi' }])
    expect(parseFrame('beep')).toEqual([])
    expect(parseFrame('[1,2]')).toEqual([])
  })

  it('applyEvents merges updates, adds creates at the front, removes deletes, ignores unknown types', () => {
    const rows = [
      { rowId: 1, title: 'a' },
      { rowId: 2, title: 'b' },
    ]
    const out = applyEvents(rows, [
      { type: 'update', id: '1', body: { title: 'A' } },
      { type: 'create', id: 3, body: { rowId: 3, title: 'c' } },
      { type: 'delete', id: 2 },
      { type: 'something_new', id: 1, body: { title: 'x' } },
    ])
    expect(out).toEqual([
      { rowId: 3, title: 'c' },
      { rowId: 1, title: 'A' },
    ])
    expect(rows[0]!.title).toBe('a')
  })
})
