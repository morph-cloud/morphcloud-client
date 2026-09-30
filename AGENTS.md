# Building an app on Morphcloud with `@morphcloud/client`

This file is the one source of the guidance for coding agents (Lovable, Claude Code, Cursor…)
that write a frontend on Morphcloud. The Lovable workspace skill is a copy of it.

## Rules

1. Use `@morphcloud/client` for every call to Morphcloud. Do not write `fetch` calls, token
   code or WebSocket code for Morphcloud yourself.
2. Put the workspace app's connect data in the app config, unchanged. The workspace admin gets
   it from the app's page in Morphcloud (`…/ws/{slug}/app/{id}`). Never ask a user for a
   Morphcloud password, API key or secret.
3. Every address the app is served from must be one of the app's return addresses. A Lovable
   project has three: `https://id-preview--<project id>.lovable.app/`,
   `https://preview--<name>.lovable.app/` and `https://<name>.lovable.app/`. If one is missing,
   sign-in is refused and the browser blocks the API calls.
4. Show the server's error message to the user. It is written for them.
5. If `control.action[method].authorized` is false, show the control disabled with its
   `message`. Do not hide it.
6. Do not build paths from strings. Use the helpers below, or follow `linkTo` values from a
   response.

## Setup

```ts
import { createMorphcloud } from '@morphcloud/client'

// The workspace app's connect data, as Morphcloud shows it.
export const mc = createMorphcloud({
  clientId: '…',
  authorizeUrl: 'https://auth.morphcloud.com/oauth/authorize',
  tokenUrl: 'https://auth.morphcloud.com/oauth/token',
  revokeUrl: 'https://auth.morphcloud.com/oauth/revoke',
  apiBaseUrl: 'https://auth.morphcloud.com',
  workspacePath: '/org/…/ws/…',
  scope: 'mcp:read mcp:write',
})
```

On page load, before you render:

```ts
await mc.auth.handleRedirect()      // finishes a sign-in when the page is the return address
mc.auth.isSignedIn()                // show a "Sign in with Morphcloud" button when false
mc.auth.signIn()                    // on that button
mc.auth.signOut()
mc.auth.onChange((signedIn) => …)   // a lost session calls this with false
```

**Call these in the browser only**: in a `useEffect`, a click handler, or a client-only
component. Never call them in a route loader, a server function or during render. On the server
there is no signed-in member, so `isSignedIn()` is `false`, `handleRedirect()` does nothing and
`signIn()` throws. Load Morphcloud data in the browser after sign-in, for the same reason: the
server has no token.

The return address is the page's origin + `/` by default. Pass `{ redirectUri }` as the second
argument to `createMorphcloud` to change it; it must match a return address exactly.

## Data

```ts
const tasks = mc.workspace.table('tasks')          // the table's slug

const page = await tasks.rows({ size: 50, sortField: 'dueDate', sortDirection: 'asc',
                                filter: { done: 'false', priority: ['high', 'urgent'] } })
page.data.content        // rows: keys are the columns' camelCase names, plus rowId and linkTo
page.data.totalElements  // all matching rows, not only this page
page.data.columns        // the table's columns: nameCamel, nameSlug, type, isRequired, …

for await (const row of tasks.allRows()) { … } // every row, page by page

await tasks.createRow({ title: 'Wash up', dueDate: '2026-10-01' })
await tasks.setCell(row.rowId, 'done', true)
await tasks.updateRow(row.rowId, { done: true, notes: 'ok' })  // one request per cell, NOT atomic
await tasks.deleteRow(row.rowId)
await tasks.deleteRows([1, 2, 3])
```

Filters: a value is `equal`, an array is `in`, `{ op: 'greater_than', value: 3 }` picks an
operator (`equal`, `not_equal`, `less_than`, `less_than_equal`, `greater_than`,
`greater_than_equal`, `in`, `not_in`, `like`, `ilike`, `is_null`, `is_not_null`). The fields you
can filter and sort on are in `page.control.action.get.handlers` (the `page` handler's `keys`).

A page holds 25 rows by default and 1000 at most. Read `totalElements`; do not assume one page
holds everything.

## Actions

Actions are Morphcloud's automations. They run by themselves when their trigger fires (for
example, when a row is created or a cell changes).

```ts
await tasks.execute(row.rowId)       // run this table's actions on one row now
await tasks.execute([1, 2, 3])       // on many rows
```

`execute` starts the run and returns. It does not wait for the result. The actions write their
results into the row, so subscribe to the table (below) and the new values arrive by themselves.
Each run is charged.

To list or create actions: `mc.workspace.actions()`, `mc.workspace.createAction(payload)`. The
fields depend on the action type — read the form at `mc.workspace.actionsPath`
(`control.action.post.form`) and the guide at `/guide` first.

## Live updates

```ts
import { applyEvents } from '@morphcloud/client'

const sub = tasks.subscribe({
  onStale: () => reload(),                            // read the rows again
  onEvents: (events) => setRows((rows) => applyEvents(rows, events)),
})
sub.close()                                           // on unmount
```

- `onStale` runs when the socket opens, after every reconnect, and when the server sends
  `resync`. Always read the data again there: events that happened while the socket was closed
  are not sent again.
- An `update` event holds only the fields that changed. `applyEvents` merges it.
- Row ids can arrive as a number or a string. `applyEvents` handles both.
- `tasks.subscribeRow(rowId, handlers)` listens to one row.

## Errors

Every method returns the server's envelope: `{ path, meta, control, data, error }`. The
methods throw a `MorphcloudError` when the server refuses:

```ts
try { … } catch (e) {
  if (isMorphcloudError(e)) {
    e.message      // show this
    e.fieldErrors  // { fieldName: what is wrong } — show next to the form fields
    e.kind         // 'network' | 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid' | …
  }
}
```

A `forbidden` error means this user may not do this. It does not mean the session ended; the
client already tried a new token. A lost session calls `mc.auth.onChange(false)`.

`mc.client.request(method, path, opts)` is the form that never throws: the envelope's `error`
holds the problem (`status: 0` when the network failed).

## Anything else

Everything in Morphcloud is a path. `mc.client.get(path)` returns the envelope at any path. Its
`control.resource` lists where you can go next (`linkTo`), and `control.action` lists what you
can do there, with the form for each action.
