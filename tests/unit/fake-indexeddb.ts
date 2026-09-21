/**
 * A faithful in-memory indexedDB double for the #351 medium tests (issue
 * #351 — lib/outbox-idb.ts runs against the REAL browser API; jsdom/node
 * have no indexedDB, so the suites that pin the owner store's persistence
 * end to end stub the global with THIS before the dynamic import).
 *
 * Fidelity notes (what the double faithfully models, and no more):
 *   · `open(name, version)` returns a request whose `onupgradeneeded` fires
 *     (asynchronously, BEFORE `onsuccess`) exactly when the database is
 *     created — the real event's ordering — with `request.result` already
 *     set to the database handle, then `onsuccess` resolves. The handle is
 *     STABLE per name, so the production code's cached open stays valid
 *     while tests clear records between scenarios;
 *   · get/put/delete requests fire their success/error events
 *     asynchronously (a microtask after creation — handlers are assigned
 *     after the call returns, exactly like the real API);
 *   · quota/private-mode refusals fire `onerror` with a `QuotaExceededError`
 *     — the real indexedDB never throws quota synchronously out of `put`;
 *   · `openRefused` models the private-mode/hard-refusal shape where the
 *     OPEN itself errors (the medium is entirely unavailable).
 *
 * It is a test double for the BROWSER API, not a stand-in for application
 * code: everything of ours that runs above it (lib/outbox-idb.ts, the
 * guarded wrapper, the zustand persist wiring) is the real implementation
 * under test.
 */

/** The error shape the real API surfaces on request failures. */
export class FakeIdbRequestError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** The quota knobs every store created by this fake answers to. */
export interface FakeIdbQuota {
  /** Hard quota / private mode: every put errors. */
  exceeded: boolean
  /** Soft quota boundary: puts of values LONGER than this error (bytes ≈ chars). */
  bytes: number
}

/** The minimal IDBRequest surface lib/outbox-idb.ts consumes. */
export class FakeIdbRequest<T = unknown> {
  result: T = undefined as unknown as T
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: ((event: { target: FakeIdbRequest<T> }) => void) | null = null
  onupgradeneeded: ((event: { target: unknown }) => void) | null = null

  /** Fire success asynchronously — handlers are assigned after creation. */
  succeed(result: T): void {
    this.result = result
    queueMicrotask(() => this.onsuccess?.())
  }

  /** Fire failure asynchronously, mirroring the real event's target/error. */
  fail(error: Error): void {
    this.error = error
    queueMicrotask(() => this.onerror?.({ target: this }))
  }
}

/** The minimal IDBObjectStore surface (string records, the kv seam's shape). */
export class FakeIdbObjectStore {
  constructor(
    readonly records: Map<string, string>,
    private readonly quota: FakeIdbQuota,
  ) {}

  get(key: IDBValidKey): FakeIdbRequest<string | undefined> {
    const request = new FakeIdbRequest<string | undefined>()
    queueMicrotask(() => request.succeed(this.records.get(String(key))))
    return request
  }

  put(value: string, key: IDBValidKey): FakeIdbRequest<IDBValidKey> {
    const request = new FakeIdbRequest<IDBValidKey>()
    queueMicrotask(() => {
      // Quota refusal — the real API fires request.onerror (never a
      // synchronous throw out of put()).
      if (this.quota.exceeded || value.length > this.quota.bytes) {
        request.fail(new FakeIdbRequestError('QuotaExceededError', 'mock quota exceeded'))
        return
      }
      this.records.set(String(key), value)
      request.succeed(key)
    })
    return request
  }

  delete(key: IDBValidKey): FakeIdbRequest<undefined> {
    const request = new FakeIdbRequest<undefined>()
    queueMicrotask(() => {
      this.records.delete(String(key))
      request.succeed(undefined)
    })
    return request
  }
}

/** The minimal IDBDatabase surface (named stores of string records). */
export class FakeIdbDatabase {
  readonly stores = new Map<string, FakeIdbObjectStore>()
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  }

  constructor(private readonly quota: FakeIdbQuota) {}

  createObjectStore(name: string): FakeIdbObjectStore {
    if (this.stores.has(name)) throw new FakeIdbRequestError('ConstraintError', `object store "${name}" already exists`)
    const store = new FakeIdbObjectStore(new Map<string, string>(), this.quota)
    this.stores.set(name, store)
    return store
  }

  transaction(storeName: string, _mode: IDBTransactionMode): { objectStore(name: string): FakeIdbObjectStore } {
    const store = this.stores.get(storeName)
    if (!store) throw new FakeIdbRequestError('NotFoundError', `no such object store "${storeName}"`)
    return { objectStore: () => store }
  }
}

/**
 * The global `indexedDB` double. Quota knobs shape the put failures the
 * guarded-persistence suites place between a full and a slimmed write.
 */
export class FakeIndexedDB {
  private readonly databases = new Map<string, FakeIdbDatabase>()
  private readonly quota: FakeIdbQuota = { exceeded: false, bytes: Number.POSITIVE_INFINITY }

  /** Hard quota / private mode: every put errors. */
  get quotaExceeded(): boolean {
    return this.quota.exceeded
  }

  set quotaExceeded(value: boolean) {
    this.quota.exceeded = value
  }

  /** Soft quota boundary: puts of values LONGER than this error. */
  get quotaBytes(): number {
    return this.quota.bytes
  }

  set quotaBytes(value: number) {
    this.quota.bytes = value
  }

  /** Private-mode hard refusal: the OPEN itself errors (medium unavailable). */
  openRefused = false

  open(name: string, _version?: number): FakeIdbRequest<FakeIdbDatabase> {
    const request = new FakeIdbRequest<FakeIdbDatabase>()
    if (this.openRefused) {
      request.fail(new FakeIdbRequestError('InvalidStateError', 'indexedDB unavailable (private mode)'))
      return request
    }
    let db = this.databases.get(name)
    const created = db === undefined
    if (created) {
      db = new FakeIdbDatabase(this.quota)
      this.databases.set(name, db)
    }
    const database = db
    queueMicrotask(() => {
      if (created) {
        // Real ordering: the upgrade transaction runs BEFORE the open
        // resolves, with request.result already the database handle.
        request.result = database
        request.onupgradeneeded?.({ target: request })
      }
      request.succeed(database)
    })
    return request
  }

  // ---------------- test accessors (what reached "disk") ----------------

  /** The named database (throws if never opened — a test bug, not a posture). */
  database(name: string): FakeIdbDatabase {
    const db = this.databases.get(name)
    if (!db) throw new Error(`fake indexedDB: database "${name}" was never opened`)
    return db
  }

  /** Read one kv record as the production code would (string | null). */
  record(dbName: string, storeName: string, key: string): string | null {
    const store = this.database(dbName).stores.get(storeName)
    if (!store) throw new Error(`fake indexedDB: store "${storeName}" does not exist`)
    return store.records.get(key) ?? null
  }

  /** Write one kv record directly (seeding a pre-existing on-disk state). */
  setRecord(dbName: string, storeName: string, key: string, value: string | null): void {
    const store = this.database(dbName).stores.get(storeName)
    if (!store) throw new Error(`fake indexedDB: store "${storeName}" does not exist`)
    if (value === null) store.records.delete(key)
    else store.records.set(key, value)
  }

  /** Clear every record (a clean device between scenarios; handles stay valid). */
  clearRecords(): void {
    for (const db of this.databases.values()) {
      for (const store of db.stores.values()) store.records.clear()
    }
  }
}
