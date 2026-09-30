# @morphcloud/client

A client for the [Morphcloud](https://morphcloud.com) Navigator API, for browser apps (and Node).
It signs members in to a workspace app with OAuth PKCE, returns the Navigator envelope for every
call, names the workspace → table → row → cell paths, runs actions, and keeps a live socket open
with reconnects.

```sh
npm install @morphcloud/client
```

```ts
import { createMorphcloud } from '@morphcloud/client'

const mc = createMorphcloud(connect) // your workspace app's connect data
await mc.auth.handleRedirect()
if (!mc.auth.isSignedIn()) await mc.auth.signIn()
const { data } = await mc.workspace.table('tasks').rows({ size: 50 })
```

The full guide — for people and for coding agents such as Lovable — is [AGENTS.md](./AGENTS.md).

## This repository is a mirror

The source lives in Morphcloud's backend repository, next to the API it calls, so an API change
and its client change are made together. Every change to `main` there is copied here, and this
repository publishes the package to npm.

Issues are welcome here. Pull requests cannot be merged here directly; we copy an accepted change
into the backend repository, and it comes back through the mirror.

## Development

```sh
npm install
npm run typecheck && npm test && npm run build
```

For maintainers, in the backend repository: when a change alters the envelope
(`NavigatorTraversalResponse`, `NavigatorNodeControl`), the row page (`ApiRowPageResponse`), the
socket frame (`NavigatorSocketMessage`) or the workspace app connect data (`ApiWorkspaceAppConnect`),
change `client/src/` and `client/AGENTS.md` in the same commit. To publish, raise `version` in
`package.json`; the mirror publishes a version that npm does not have yet.
