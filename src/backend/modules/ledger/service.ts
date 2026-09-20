// Double-entry ledger engine (spec §39) — the single way money moves.
// Every financial write posts a LedgerTransaction with balanced debit/credit
// legs inside one db.$transaction. History is immutable: corrections are
// new reversal transactions, never edits or deletes.
//
// DB-3 (#124, migration 14_ledger_invariants): these invariants are ALSO
// DB-enforced on SQLite — entries are append-only (UPDATE/DELETE rejected
// by trigger), the txn lifecycle is pending → posted with the posting
// transition as the sole legal UPDATE, and Σdebits = Σcredits is asserted by the
// LedgerTransaction_posting_gate trigger at the pending→posted transition
// (the SQLite equivalent of the Supabase deferred COMMIT constraint — see
// the migration's DESIGN NOTE for why the enforcement point is the final
// UPDATE, not a per-entry check).
//
// DB-11 (#133, migration 21_ledger_reversals_as_rows): reversals are NEW
// rows, never updates. The reversal transaction carries reversalOfId → the
// original; "was this reversed?" is DERIVED from that link (findReversalOf /
// isReversed below) — the original row is byte-identical forever after its
// posting transition, on both the SQLite and the Supabase path.

import { db } from '@/backend/lib/db'
import type { Cents } from '@/backend/lib/money'
import { centsToKes, sumCents } from '@/backend/lib/money'
import type { LedgerTransaction, Prisma } from '@prisma/client'

export interface LedgerLineInput {
  accountCode: string
  side: 'debit' | 'credit'
  /** KSh cents (issue #122) — integer money, exact by construction. */
  amount: Cents
  memo?: string
}

export interface PostLedgerInput {
  projectId: string | null
  description: string
  lines: LedgerLineInput[]
  postedBy: string
  postedRole: string
  occurredAt?: Date
  idempotencyKey?: string
  reversalOfId?: string
}

/** Platform chart of accounts (created lazily, idempotent). */
export const PLATFORM_ACCOUNTS = [
  { code: 'CASH_MPESA', name: 'Mobile Money Pool (simulated)', kind: 'asset', normalSide: 'debit' as const, ownerType: 'platform' },
  { code: 'CASH_BANK', name: 'Bank Float (simulated)', kind: 'asset', normalSide: 'debit' as const, ownerType: 'platform' },
]

export async function ensureAccount(code: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await db.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  return ensureAccountTx(db, code)
}

/**
 * Account resolution INSIDE a db.$transaction — used by postLedgerTransactionInTx
 * so atomic money flows never post against a half-created chart of accounts.
 * Understands the platform accounts, the ESCROW:<projectId> / EXPENSE:<projectId>
 * project convention and pre-created WALLET:<code> accounts; anything else must
 * be created explicitly first.
 */
export async function ensureAccountTx(tx: Prisma.TransactionClient, code: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  const platform = PLATFORM_ACCOUNTS.find((a) => a.code === code)
  if (platform) {
    const created = await tx.ledgerAccount.create({ data: { code: platform.code, name: platform.name, kind: platform.kind, normalSide: platform.normalSide, ownerType: 'platform' } })
    return { id: created.id, kind: created.kind, name: created.name }
  }
  if (code.startsWith('ESCROW:')) {
    return ensureProjectAccountTx(tx, code.slice('ESCROW:'.length), code, `Project Escrow — ${code.slice(-6)}`, 'liability')
  }
  if (code.startsWith('EXPENSE:')) {
    return ensureProjectAccountTx(tx, code.slice('EXPENSE:'.length), code, `Project Expense — ${code.slice(-6)}`, 'expense')
  }
  throw new Error(`Unknown ledger account code: ${code} — create the account first`)
}

/** Project-scoped account (escrow / expense / payable). */
export async function ensureProjectAccount(projectId: string, code: string, name: string, kind: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await db.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  return ensureProjectAccountTx(db, projectId, code, name, kind)
}

/** Project-scoped account creation inside a db.$transaction. */
export async function ensureProjectAccountTx(tx: Prisma.TransactionClient, projectId: string, code: string, name: string, kind: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  const created = await tx.ledgerAccount.create({
    data: { code, name, kind, normalSide: kind === 'asset' || kind === 'expense' ? 'debit' : 'credit', projectId, ownerType: 'project', ownerId: projectId },
  })
  return { id: created.id, kind: created.kind, name: created.name }
}

export async function ensureEscrowAccount(projectId: string) {
  return ensureProjectAccount(projectId, `ESCROW:${projectId}`, `Project Escrow — ${projectId.slice(-6)}`, 'liability')
}

export async function ensureExpenseAccount(projectId: string) {
  return ensureProjectAccount(projectId, `EXPENSE:${projectId}`, `Project Expense — ${projectId.slice(-6)}`, 'expense')
}

// BE-10 (issue #77) — honest limitation of this ref generator: the counter is
// IN-PROCESS (module scope), so a multi-process deployment (compose scale,
// any setup running several app instances against one DB) can mint the same
// LX-<year>-<seq> concurrently. It CANNOT corrupt the ledger: LedgerTransaction.ref
// is @unique (schema.prisma), so a collision fails CLOSED — the insert throws
// (P2002) and the whole money $transaction rolls back; the caller surfaces an
// honest 500 and the retry lands a fresh ref. No money is ever written twice
// or lost. The same pattern (counter + Date.now()%1000 salt) is documented at
// its other site in modules/wallet/service.ts. A DB-derived sequence
// (max+1 in-tx, or retry-on-P2002) is the upgrade path if this ever runs
// multi-process in production — deliberately not added now (single drain
// process today; no premature machinery).
let refCounter = 0
export function nextLedgerRef(): string {
  const now = new Date()
  refCounter = (refCounter + 1) % 100000
  return `LX-${now.getFullYear()}-${String(refCounter).padStart(6, '0')}-${Date.now() % 1000}`
}

/** Cash account code for a payment rail — one mapping, one source of truth. */
export function cashAccountForMethod(method: string): 'CASH_MPESA' | 'CASH_BANK' {
  // mpesa settles into the (simulated) mobile-money pool; bank / card / cash
  // settle into the (simulated) bank float.
  return String(method).toLowerCase() === 'mpesa' ? 'CASH_MPESA' : 'CASH_BANK'
}

function validateLines(lines: LedgerLineInput[]) {
  // Service-level pre-check (fail fast, honest error messages). The SAME
  // invariant is DB-enforced at the posting gate — migration 14's
  // LedgerTransaction_posting_gate trigger asserts Σdebits = Σcredits when
  // status moves pending→posted, so even a writer that bypasses this
  // service can never post unbalanced legs (issue #124 / DB-3).
  if (!lines.length) throw new Error('Ledger transaction needs at least one line')
  for (const l of lines) {
    if (!(l.amount > 0n)) throw new Error('Ledger amounts must be positive')
    if (l.side !== 'debit' && l.side !== 'credit') throw new Error('Ledger side must be debit or credit')
  }
  const debit = sumCents(lines.filter((l) => l.side === 'debit').map((l) => l.amount))
  const credit = sumCents(lines.filter((l) => l.side === 'credit').map((l) => l.amount))
  // EXACT equality — the float era needed a 0.005 tolerance here (DB-1);
  // integer cents make balanced legs a bigint ===, so a one-cent
  // imbalance can never post. "The ledger never lies."
  if (debit !== credit) {
    throw new Error(`Unbalanced ledger transaction: debits ${debit} ≠ credits ${credit} (cents)`)
  }
}

/**
 * Post one balanced double-entry transaction. Fails hard when:
 *  - lines are empty / amounts are non-positive
 *  - debits ≠ credits (spec §39 invariant)
 *  - idempotency key already used (returns the original txn — no double post)
 */
export async function postLedgerTransaction(input: PostLedgerInput) {
  return db.$transaction((tx) => postLedgerTransactionInTx(tx, input))
}

/**
 * The posting core, INSIDE a caller-owned db.$transaction — used by every
 * atomic money flow (escrow top-up, milestone release, invoice payment,
 * wages, expense posting, payment requests). Runs the idempotency check and
 * the chart-of-accounts resolution on the SAME tx client as the posting so
 * the whole money movement commits or rolls back as one unit.
 */
export async function postLedgerTransactionInTx(tx: Prisma.TransactionClient, input: PostLedgerInput) {
  validateLines(input.lines)

  if (input.idempotencyKey) {
    const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
    if (existing) return existing
  }

  const resolved = await Promise.all(
    input.lines.map(async (l) => ({ line: l, account: await ensureAccountTx(tx, l.accountCode) })),
  )

  const reversalOf = input.reversalOfId
    ? await tx.ledgerTransaction.findUnique({ where: { id: input.reversalOfId } })
    : null

  const pending = await tx.ledgerTransaction.create({
    data: {
      ref: nextLedgerRef(),
      projectId: input.projectId,
      description: input.description,
      occurredAt: input.occurredAt ?? new Date(),
      postedBy: input.postedBy,
      postedRole: input.postedRole,
      reversalOfId: reversalOf?.id ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      // DB-3 (#124): born pending — the DB rejects any other birth status
      // and only allows legs to attach while pending (migration 14), so the
      // posting transition below is the ONE balance-enforcement point.
      status: 'pending',
      entries: {
        create: resolved.map(({ line, account }) => ({
          accountId: account.id,
          side: line.side,
          amount: line.amount,
          memo: line.memo ?? null,
        })),
      },
    },
    include: { entries: true },
  })
  // The posting gate (#124 / migration 14): this final UPDATE is where the
  // DB asserts Σdebits = Σcredits (LedgerTransaction_posting_gate) — the
  // SQLite equivalent of the Supabase deferred-at-COMMIT constraint.
  // SQLite has no deferred triggers and Prisma writes each leg as its own
  // INSERT inside this transaction, so a per-entry check would fire
  // mid-batch; gating the LAST write of the flow checks the complete leg
  // set and rolls back the whole post on violation.
  const txn = await tx.ledgerTransaction.update({
    where: { id: pending.id },
    data: { status: 'posted' },
    include: { entries: true },
  })
  // DB-11 (#133): a reversal input does NOT touch the original row. The
  // reversal txn this call just posted carries reversalOfId → original —
  // that link IS the reversal record; "is reversed?" is derived from it
  // (findReversalOf below). The pre-#133 model stamped the original here
  // (status 'reversed' + reversalRef); migration 21's update guard now
  // rejects that write class entirely.
  return txn
}

/**
 * A loaded ledger transaction with its entries (and their account codes) —
 * the shape `reverseLedgerTransactionInTx` reverses. Structural so both the
 * real Prisma client and in-memory test stubs satisfy it. Carries NO status:
 * reversal state is DERIVED from the reversalOfId link (#133), so the stored
 * status of the row being reversed is irrelevant to the reversal flow.
 */
export interface ReversibleLedgerTxn {
  id: string
  ref: string
  projectId: string | null
  entries: { side: string; amount: Cents; memo: string | null; account: { code: string } }[]
}

/**
 * Reverse a posted transaction with mirrored entries, INSIDE a caller-owned
 * db.$transaction (issue #213) — the in-tx twin of postLedgerTransactionInTx.
 * Callers (the wallet service's reverseTransaction) wrap this with their own
 * projection updates so the mirrored post and every derived-cache repair
 * commit or roll back as ONE unit. The original must be pre-loaded with
 * `include: { entries: { include: { account: true } } }`.
 *
 * DB-11 (#133): this writes ONLY new rows — the original is never UPDATEd.
 * The double-reversal guard reads the DERIVED state (does any row's
 * reversalOfId already point at this original?), and the unique index on
 * reversalOfId (migration 21) is the DB-level backstop: even a racing writer
 * that skips this check cannot land a second reversal for one original.
 */
export async function reverseLedgerTransactionInTx(
  tx: Prisma.TransactionClient,
  original: ReversibleLedgerTxn,
  reason: string,
  postedBy: string,
  postedRole: string,
) {
  const existingReversal = await tx.ledgerTransaction.findUnique({ where: { reversalOfId: original.id } })
  if (existingReversal) throw new Error('Transaction already reversed')
  return postLedgerTransactionInTx(tx, {
    projectId: original.projectId,
    description: `REVERSAL of ${original.ref} — ${reason}`,
    lines: original.entries.map((e) => ({
      accountCode: e.account.code,
      side: (e.side === 'debit' ? 'credit' : 'debit') as 'debit' | 'credit',
      amount: e.amount,
      memo: e.memo ?? undefined,
    })),
    postedBy,
    postedRole,
    reversalOfId: original.id,
  })
}

/** Reverse a posted transaction with mirrored entries (never edit history). */
export async function reverseLedgerTransaction(txnId: string, reason: string, postedBy: string, postedRole: string) {
  const original = await db.ledgerTransaction.findUnique({
    where: { id: txnId },
    include: { entries: { include: { account: true } } },
  })
  if (!original) throw new Error('Ledger transaction not found')
  return db.$transaction((tx) => reverseLedgerTransactionInTx(tx, original, reason, postedBy, postedRole))
}

// ---------------------------------------------------------------------------
// DB-11 (#133) — DERIVED reversal state: the single seam for "was reversed?".
// A transaction is reversed iff some later transaction's reversalOfId points
// at it. The original row itself is append-only (its stored status stays
// 'posted'; pre-#133 rows may still carry legacy 'reversed'/reversalRef
// stamps, which this seam deliberately IGNORES — the link is the truth).
// Every reader (finance slice, wallet txn lists, double-reversal guard) goes
// through these helpers instead of filtering on txn.status/reversalRef.
// ---------------------------------------------------------------------------

/**
 * The reversal transaction linked to `txnId`, if any — the derived "is this
 * row reversed and by what". Unique-index backed (migration 21): at most one
 * reversal can point at any original. Accepts the db client OR a transaction
 * client (same contract as accountSideSums) so in-tx guards read
 * uncommitted rows.
 */
export async function findReversalOf(
  client: Prisma.TransactionClient,
  txnId: string,
): Promise<LedgerTransaction | null> {
  return client.ledgerTransaction.findUnique({ where: { reversalOfId: txnId } })
}

/** Derived "was this transaction reversed?" — the ONLY way to ask (#133). */
export async function isReversed(txnId: string): Promise<boolean> {
  return (await findReversalOf(db, txnId)) !== null
}

/**
 * Bulk read-model for list views: original txn id → reversing txn ref, for
 * every id in `txnIds` that has a reversal. One indexed query regardless of
 * page size — presence in the map IS "is reversed", the value is the
 * correcting ref for display (replaces the pre-#133 reversalRef stamp).
 */
export async function reversalRefsByTxnId(txnIds: string[]): Promise<Map<string, string>> {
  if (!txnIds.length) return new Map()
  const rows = await db.ledgerTransaction.findMany({
    where: { reversalOfId: { in: txnIds } },
    select: { reversalOfId: true, ref: true },
  })
  const pairs: Array<[string, string]> = []
  for (const r of rows) {
    if (r.reversalOfId) pairs.push([r.reversalOfId, r.ref])
  }
  return new Map(pairs)
}

/**
 * Σdebit / Σcredit for one account, computed IN SQL (issue #144 — the
 * aggregation half of DB-6). One grouped SUM over the LedgerEntry(accountId)
 * index (migration 10): constant memory, index-backed, and the cost stops
 * growing with account age. Before #144 every balance read loaded the
 * account's ENTIRE entry history into JS and reduced it — O(history) rows
 * crossed the seam per read on a ledger that is append-only by design.
 *
 * Accepts the db client OR a transaction client — the wallet ops call it on
 * the SAME tx client as their posting so the in-transaction balance re-check
 * keeps seeing uncommitted rows (race safety unchanged).
 *
 * Semantics preserved bit-for-bit from the pre-#144 JS reduce: BigInt cents,
 * every entry counts (no status/normalSide filter — the old reduce summed
 * all rows), sides other than debit/credit are ignored, missing group = 0.
 */
export async function accountSideSums(
  client: Prisma.TransactionClient,
  accountId: string,
): Promise<{ debit: Cents; credit: Cents }> {
  const groups = await client.ledgerEntry.groupBy({
    by: ['side'],
    _sum: { amount: true },
    where: { accountId },
  })
  let debit = 0n
  let credit = 0n
  for (const g of groups) {
    if (g.side === 'debit') debit = g._sum.amount ?? 0n
    else if (g.side === 'credit') credit = g._sum.amount ?? 0n
  }
  return { debit, credit }
}

/**
 * Derived balance for an account — the ONLY way balance is known (spec §39).
 * Returns KSh CENTS (issue #122): entries sum exactly in bigint; callers
 * convert to KSh only at the API/UI boundary (centsToKes). The Σdebit/Σcredit
 * legs come from SQL SUM aggregation (issue #144); the sign convention is the
 * same one the old in-JS reduce used, keyed on the account's kind.
 */
export async function derivedBalance(accountCode: string): Promise<Cents> {
  // Account row only — NO `include: { entries: true }` (issue #144: balance
  // paths never load unbounded entry history into JS).
  const account = await db.ledgerAccount.findUnique({
    where: { code: accountCode },
    select: { id: true, kind: true },
  })
  if (!account) return 0n
  const { debit, credit } = await accountSideSums(db, account.id)
  return account.kind === 'asset' || account.kind === 'expense' ? debit - credit : credit - debit
}

/** Display-facing twin of derivedBalance — KSh number for API/UI edges. */
export async function derivedBalanceKes(accountCode: string): Promise<number> {
  return centsToKes(await derivedBalance(accountCode))
}

/** Tx operations used by the wallet service (kept here for reuse). */
export type TxClient = Prisma.TransactionClient
