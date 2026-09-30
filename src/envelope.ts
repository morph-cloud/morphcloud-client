/**
 * The Navigator envelope — the one shape every Morphcloud response has, errors included.
 *
 * Mirrors `NavigatorTraversalResponse` and `NavigatorNodeControl` in the backend's `navigator`
 * module. Every string that names a kind of thing (a form field type, a socket event type, an
 * action key) is an OPEN union: the backend adds values without a client release, so an
 * unknown value must pass through untouched, never throw.
 */

/** An open string union: the listed values get autocomplete, any other string still type-checks. */
export type Open<T extends string> = T | (string & {})

/** The title and help text of a path, written for the person using the app. */
export type NavMeta = {
  title?: string
  hint?: string
  description?: string
  avatarUrl?: string
}

export type NavFormFieldType = Open<
  | 'text' | 'textarea' | 'password' | 'bool' | 'select' | 'integer' | 'decimal' | 'percentage'
  | 'telephone_number' | 'year' | 'date' | 'time' | 'datetime' | 'datetimez' | 'yearmonth'
  | 'file' | 'excel' | 'word' | 'pdf' | 'image' | 'uuid' | 'search' | 'hidden'
>

/**
 * One input of an action's form. The server owns the form: render the fields it sends, in
 * order, and never hard-code field names.
 */
export type NavFormField = {
  /** Which input to render. `hidden` is sent in the payload but never shown. */
  type: NavFormFieldType
  /** The key of this field in the payload you submit. */
  name: string
  /** The label for a person. */
  title: string
  /** Help text for a person. */
  description?: string | null
  /**
   * What the field means and which values the server accepts, written for an AI agent. It is
   * more exact than `description`: read it before you fill the field in code.
   */
  agentDescription?: string | null
  placeholder?: string | null
  /** The server refuses the payload when a required field is missing or empty. */
  required: boolean
  /** The least value (numbers) or length (text). `null` = no limit. */
  min?: number | null
  /** The greatest value (numbers) or length (text). `null` = no limit. */
  max?: number | null
  /** The allowed values of a `select` field: send `value`, show `text`. */
  options?: { value: string; text: string }[]
  /** For a `search` field: the keys to search on with `?formSearch:<key>=<text>`. */
  searchKeys?: string[] | null
  /** A value the server presets. Send it unless the user changes it. */
  value?: string | null
  /** The preset `value` must go back unchanged. Show the field disabled, not hidden. */
  readOnly?: boolean
}

/** The form of an action: the fields of one payload. */
export type NavForm = {
  fields: NavFormField[]
  /** True when the action takes a JSON array of payloads (see `NavAction.bulk`). */
  isArray?: boolean
}

/** One sub-handler of an action: `page` (filter/sort keys), `formSearch`, `download`, … */
export type NavActionHandler = {
  name: Open<'page' | 'formSearch' | 'download' | 'search'>
  keys?: string[]
}

/**
 * One thing a caller can do at a path, keyed by HTTP method in `control.action`:
 * `get` reads, `post` creates, `put`/`patch` change, `delete` removes. Every path lists all of
 * its actions, allowed or not, so an app can show a refused action disabled with its reason.
 */
export type NavAction = {
  /** True when this caller may do it now. When false, show it disabled with `message`. */
  authorized: boolean
  /** Why the action is refused. Present only when `authorized` is false. */
  message?: string | null
  /** Every reason a state-based refusal gives. `message` repeats the first one. */
  blockers?: string[] | null
  /** The sub-handlers of the action. On `get`, the `page` handler's `keys` are the filter/sort fields. */
  handlers?: NavActionHandler[]
  /** The payload this action takes. Absent for an action with no body (most `get` and `delete`). */
  form?: NavForm | null
  /**
   * Bulk support. A field name (`"rowId"`) means the body is an array of that field's values.
   * The literal `"payload"` means the body is an array of this action's own form payload.
   */
  bulk?: string | null
}

/** A place this path links to, keyed by name in `control.resource` (`table`, `row`, `column`…). */
export type NavResource = {
  /** The path to request next. */
  linkTo: string
  /** True when this caller may open it. When false, `message` says why. */
  authorized: boolean
  message?: string | null
  /** The title and help text of the linked place. */
  meta?: NavMeta
}

export type NavMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** What a caller can do from a path: where to go (`resource`) and what to do (`action`). */
export type NavControl = {
  /** The places this path links to, by name. */
  resource: Record<string, NavResource>
  /** The actions at this path, by HTTP method. */
  action: Partial<Record<Open<NavMethod>, NavAction>>
  /** True when the path serves a file (`?download=true`). */
  downloadable: boolean
  /** True when the path takes a child segment (an id or slug): a collection. */
  hasNext: boolean
  /** True when the path has a live socket (see `subscribe`). */
  connectable: boolean
  /** True when the path returns customer data. */
  dataBearing: boolean
  /** True when the path is served to anyone, signed in or not. */
  publicContent: boolean
  /** True when an action here can send data out of Morphcloud (email, web call…). */
  egress: boolean
  /** True when an action here is charged. */
  billable: boolean
}

export type NavError = {
  message: string
  /** The HTTP status. `0` means the request never reached the server. */
  status: number
  fieldErrors?: Record<string, string>
  lastSuccessfulRoute?: string
  /** Bulk element failures only: the 0-based index that failed (the message counts from 1). */
  elementIndex?: number
  completedCount?: number
  totalCount?: number
  completedResults?: unknown[]
}

/**
 * The Navigator envelope: every Morphcloud response has this shape, errors included. `data` is
 * the payload; `control` says where the caller can go next and what it can do here; `error` is
 * set when the request was refused.
 */
export type Nav<T = unknown> = {
  /** The path that answered. */
  path?: string
  /** The web-app URL of this node, when it has a page there. */
  web?: string
  /** The title and help text of this path. */
  meta?: NavMeta
  control?: NavControl
  /** The payload. A collection answers with a `NavPage`. */
  data?: T | null
  /** Set when the request was refused; `data` is then absent. */
  error?: NavError | null
  /** The parent entities (org, workspace, table…), only when the request asks with `?context=true`. */
  context?: Record<string, unknown> | null
  /** The backend version that served the response. */
  version?: string
}

/** The `data` of a paged collection. */
export type NavPage<T = Record<string, unknown>> = {
  content: T[]
  totalElements: number
  totalPages: number
  request: { page: number; size: number }
  searchableFields?: string[]
}

/** One column of a table, as the row page carries it inline. */
export type Column = {
  type: string
  name: string
  /** The key in the URL: `…/cell/{nameSlug}`. */
  nameSlug: string
  /** The key in a row object. */
  nameCamel: string
  description?: string | null
  isRequired: boolean
  isUnique: boolean
  isInput: boolean
  isSystem: boolean
  orderIndex: number
  linkTo?: string
  [extra: string]: unknown
}

/** A row page: the page fields plus the table's columns. */
export type RowPage<R = Row> = NavPage<R> & { columns?: Column[] }

/** A row as the API returns it: system columns, the table's own columns by `nameCamel`, and `linkTo`. */
export type Row = {
  rowId: number
  linkTo: string
  createdAt?: string
  createdBy?: string
  updatedAt?: string
  updatedBy?: string
  actionStatus?: string | null
  [column: string]: unknown
}

/** The body of a DELETE with no other result: where the deleted entity lived. */
export type NavDeleted = { linkTo: string }
