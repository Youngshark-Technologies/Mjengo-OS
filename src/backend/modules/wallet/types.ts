// Wallet / finance domain types (spec §36-§40) — the FinanceSlice payload:
// payment requests, double-entry ledger view, wallet projection, and the
// budget → committed → spent → remaining rollup.

export interface PaymentRequestRow {
  id: string
  requestCode: string
  description: string
  amount: number
  payee: string
  method: string
  status: string
  relatedEntityType: string | null
  relatedEntityId: string | null
  requestedByRole: string
  requestedByName: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  paidAt: string | null
  /** Ledger transaction ref once paid (F-MONEY "Ledger" column). */
  ledgerRef: string | null
  createdAt: string
}

export interface LedgerEntryRow {
  accountCode: string
  accountName: string
  side: string // debit, credit
  amount: number
}

export interface LedgerTxnRow {
  id: string
  ref: string
  description: string
  occurredAt: string
  status: string // DERIVED (#133): 'reversed' iff a reversal txn links back via reversalOfId; the stored row is append-only 'posted'
  reversalOfRef: string | null // DERIVED (#133): the reversing txn's ref, from the reversalOfId link (not the legacy stored stamp)
  postedBy: string
  postedRole: string
  entries: LedgerEntryRow[]
  total: number
}

export interface LedgerAccountRow {
  code: string
  name: string
  kind: string // asset, liability, revenue, expense, equity
  normalSide: string
  balance: number
}

export interface WalletRow {
  code: string
  label: string
  ownerType: string
  balance: number // derived from ledger entries
  status: string
}

/** Escrow wallet projection vs the ledger (spec §39 — the ledger wins). */
export interface EscrowProjection {
  /** Stored EscrowWallet.balance — a projection/cache. */
  projected: number
  /** Derived from ESCROW:<projectId> ledger entries — the source of truth. */
  derived: number
  /** True when the projection matches the derived balance (chip goes green). */
  consistent: boolean
  /** Drift (derived − projected) when inconsistent. */
  drift: number
  /** Backing ledger account id (set by every escrow posting). */
  ledgerAccountId: string | null
}

export interface FinanceSlice {
  paymentRequests: PaymentRequestRow[]
  ledger: {
    transactions: LedgerTxnRow[]
    accounts: LedgerAccountRow[]
  }
  wallet: WalletRow | null
  escrowLedgered: boolean // true when top-ups post ledger rows (A-1 complete)
  /** Escrow projection-vs-ledger consistency (F-MONEY honesty chip). */
  escrow: EscrowProjection | null
  committed: number // open POs + approved-unpaid invoices + pending variations
  remaining: number // budget − committed − spent
  /** Budget the rollup is computed against (phase budgets, matching ProjectSummary). */
  budget: number
  /** Σ legacy Transaction rows (the spend side of the rollup). */
  spent: number
}

/** Empty slice — safe fallback for stale persisted payloads predating F-MONEY. */
export const EMPTY_FINANCE_SLICE: FinanceSlice = {
  paymentRequests: [],
  ledger: { transactions: [], accounts: [] },
  wallet: null,
  escrowLedgered: false,
  escrow: null,
  committed: 0,
  remaining: 0,
  budget: 0,
  spent: 0,
}
