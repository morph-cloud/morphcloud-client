import { childPath, resourceOf } from './client.js'
import type { Client, Query } from './client.js'
import type { Column, Nav, NavDeleted, NavPage, Row, RowPage } from './envelope.js'
import { subscribe } from './socket.js'
import type { SubscribeHandlers, SubscribeOptions, Subscription } from './socket.js'

/**
 * The shape every Morphcloud app has: a workspace holds tables, a table holds rows, a row holds
 * cells, and actions run against rows. These classes only name paths under the workspace root
 * and call the Navigator there — every result is the server's own envelope. For anything they
 * do not cover, call `client.get(path)` and follow `control.resource`.
 */

export type FilterOp =
  | 'equal' | 'not_equal' | 'less_than' | 'less_than_equal' | 'greater_than' | 'greater_than_equal'
  | 'in' | 'not_in' | 'like' | 'ilike' | 'is_null' | 'is_not_null'

/** A bare value is `equal`, an array is `in`; `{ op }` picks the operator. */
export type FilterValue =
  | string | number | boolean
  | readonly (string | number)[]
  | { op: FilterOp; value?: string | number | readonly (string | number)[] }

export type PageQuery = {
  /** 0-based. */
  page?: number
  /** Default 25, most 1000. */
  size?: number
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  /** Keys are the fields the path's `page` handler lists (`control.action.get.handlers`). */
  filter?: Record<string, FilterValue>
}

export function pageQuery(q: PageQuery = {}): Query {
  const query: Query = {
    page: q.page,
    size: q.size,
    sortField: q.sortField,
    sortDirection: q.sortDirection,
  }
  for (const [field, f] of Object.entries(q.filter ?? {})) {
    if (typeof f === 'object' && f !== null && !Array.isArray(f) && 'op' in f) {
      const op = f as { op: FilterOp; value?: string | number | readonly (string | number)[] }
      query[`filter:${field}:${op.op}`] = op.value === undefined ? '' : (op.value as Query[string])
    } else {
      query[`filter:${field}`] = f as Query[string]
    }
  }
  return query
}

/**
 * Every item of a paged collection, page by page. On a table that changes while you read it,
 * a row can be skipped or read twice, because pages are offsets. For a stable read, sort on a
 * field that does not change (`rowId`, the default).
 */
export async function* allPages<T>(client: Client, path: string, q: PageQuery = {}): AsyncGenerator<T> {
  const size = q.size ?? 1000
  for (let page = q.page ?? 0; ; page++) {
    const { data } = await client.get<NavPage<T>>(path, pageQuery({ ...q, page, size }))
    const content = data?.content ?? []
    yield* content
    if (content.length < size || page + 1 >= (data?.totalPages ?? 0)) return
  }
}

export class Workspace {
  constructor(
    readonly client: Client,
    /** The workspace root, e.g. `/org/abc/ws/claims` (a workspace app's `workspacePath`). */
    readonly path: string,
  ) {}

  get(): Promise<Nav<Record<string, unknown>>> {
    return this.client.get(this.path)
  }

  /** The workspace's tables, paged. */
  tables(q?: PageQuery): Promise<Nav<NavPage<TableSummary>>> {
    return this.client.get(childPath(this.path, 'table'), pageQuery(q))
  }

  /** A table by its slug (`nameSlug`). No request is sent until you call a method. */
  table(slug: string): Table {
    return new Table(this.client, childPath(this.path, 'table', slug))
  }

  /** Create a table. The form is `control.action.post.form` on `tablesPath`. */
  createTable(payload: Record<string, unknown>): Promise<Nav<TableSummary>> {
    return this.client.post(this.tablesPath, payload)
  }

  get tablesPath(): string {
    return childPath(this.path, 'table')
  }

  /** The workspace's actions, paged. */
  actions(q?: PageQuery): Promise<Nav<NavPage<Record<string, unknown>>>> {
    return this.client.get(this.actionsPath, pageQuery(q))
  }

  /** An action's path, by its slug. Read it with `client.get` to see its settings and forms. */
  action(slug: string): string {
    return childPath(this.actionsPath, slug)
  }

  /**
   * Create an action. The fields depend on the action type; read the form on `actionsPath`
   * (`control.action.post.form`) and the platform guide at `/guide` before you build one.
   */
  createAction(payload: Record<string, unknown>): Promise<Nav<Record<string, unknown>>> {
    return this.client.post(this.actionsPath, payload)
  }

  get actionsPath(): string {
    return childPath(this.path, 'action')
  }

  /** Follow a named resource of the workspace envelope (`control.resource[name].linkTo`). */
  async resource(name: string): Promise<string> {
    return resourceOf(await this.get(), name).linkTo
  }
}

export type TableSummary = {
  name: string
  nameSlug: string
  description?: string
  rowCount?: number
  columnCount?: number
  actionCount?: number
  linkTo: string
  [extra: string]: unknown
}

export type RowValues = Record<string, unknown>

export class Table {
  private columnsCache: Promise<Column[]> | null = null

  constructor(
    readonly client: Client,
    readonly path: string,
  ) {}

  get(): Promise<Nav<TableSummary>> {
    return this.client.get(this.path)
  }

  get rowsPath(): string {
    return childPath(this.path, 'row')
  }

  rowPath(rowId: number | string): string {
    return childPath(this.rowsPath, rowId)
  }

  /** One page of rows, with the table's columns in `data.columns`. */
  rows<R = Row>(q?: PageQuery): Promise<Nav<RowPage<R>>> {
    return this.client.get(this.rowsPath, pageQuery(q))
  }

  /** Every row, page by page. See `allPages` for what a live table does to this read. */
  allRows<R = Row>(q?: PageQuery): AsyncGenerator<R> {
    return allPages<R>(this.client, this.rowsPath, { sortField: 'rowId', sortDirection: 'asc', ...q })
  }

  row<R = Row>(rowId: number | string): Promise<Nav<R>> {
    return this.client.get(this.rowPath(rowId))
  }

  /** The table's columns (read once, then kept). */
  columns(): Promise<Column[]> {
    this.columnsCache ??= this.rows({ size: 1 })
      .then((nav) => nav.data?.columns ?? [])
      .catch((e) => {
        this.columnsCache = null
        throw e
      })
    return this.columnsCache
  }

  /** Create one row. Keys are the column names in camelCase, as a row object has them. */
  createRow<R = Row>(values: RowValues): Promise<Nav<R>> {
    return this.client.post(this.rowsPath, values)
  }

  /**
   * Create many rows in one request. Every element is checked before any runs; then they run in
   * order and stop at the first failure, keeping the rows made before it.
   */
  createRows<R = Row>(values: readonly RowValues[]): Promise<Nav<R[]>> {
    return this.client.post(this.rowsPath, values)
  }

  /** Write one cell. `column` is the camelCase key or the slug. `null` empties the cell. */
  async setCell(rowId: number | string, column: string, value: unknown): Promise<Nav<Record<string, unknown>>> {
    const slug = await this.slugOf(column)
    return this.client.put(childPath(this.rowPath(rowId), 'cell', slug), { value })
  }

  /**
   * Write several cells of one row. Each cell is its own request, sent in order. This is not
   * atomic: when one fails, the cells before it stay written, and the error says which failed.
   */
  async updateRow(rowId: number | string, values: RowValues): Promise<void> {
    for (const [column, value] of Object.entries(values)) {
      await this.setCell(rowId, column, value)
    }
  }

  deleteRow(rowId: number | string): Promise<Nav<NavDeleted>> {
    return this.client.delete(this.rowPath(rowId))
  }

  /**
   * Delete exactly these rows. Nothing is deleted if another table refers to one of them
   * (`blockedRows`); ids not in the table come back in `notFound`.
   */
  deleteRows(rowIds: readonly (number | string)[]): Promise<Nav<Record<string, unknown>>> {
    return this.client.delete(this.rowsPath, rowIds)
  }

  /**
   * Run every action wired to this table on these rows now. This starts the run and returns;
   * the actions write their results into the rows, so `subscribe` shows them as they land.
   * Each run is charged.
   */
  execute(rowIds: number | string | readonly (number | string)[]): Promise<Nav<ExecuteResult | ExecuteResult[]>> {
    const path = childPath(this.path, 'execute')
    if (Array.isArray(rowIds)) return this.client.post(path, rowIds.map((rowId) => ({ rowId })))
    return this.client.post(path, { rowId: rowIds })
  }

  /** Live row events for the whole table. */
  subscribe(handlers: SubscribeHandlers<Partial<Row>>, options?: SubscribeOptions): Subscription {
    return subscribe(this.client, this.rowsPath, handlers, options)
  }

  /** Live events for one row. */
  subscribeRow(rowId: number | string, handlers: SubscribeHandlers<Partial<Row>>, options?: SubscribeOptions): Subscription {
    return subscribe(this.client, this.rowPath(rowId), handlers, options)
  }

  private async slugOf(column: string): Promise<string> {
    const columns = await this.columns()
    const match = columns.find((c) => c.nameCamel === column || c.nameSlug === column)
    return match?.nameSlug ?? column
  }
}

export type ExecuteResult = {
  rowId: number
  /** The run log of this execution. */
  logUuid: string
  message: string
}
