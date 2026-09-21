// Payment provider abstraction (spec §40) — the seam between MjengoOS and the
// outside payment world. The wallet/ledger engine records money movement; the
// provider interface is how a REAL rail (M-Pesa Daraja, bank API, card
// gateway…) would plug in without touching the money core.
//
// HONESTY LABEL: the default rails are simulated (SimulatedProvider /
// EscrowWalletProvider — instant, clearly labelled `simulated: true`, no
// licensed provider involved). One REAL rail exists behind the seam today:
// the Safaricom Daraja SANDBOX provider (daraja.ts), selected ONLY when the
// full DARAJA_* env set is present — otherwise the simulated M-Pesa rail
// stands, exactly as before. Daraja sandbox never moves real money (results
// stay `simulated: true`); MjengoOS is still NOT integrated with any licensed
// financial institution (spec §40: "Do not pretend to be a bank or licensed
// financial institution").

import { getDarajaProvider } from './daraja'
import { randomReferenceSuffix } from '@/shared/ids'

/** Payment method / rail identifier. */
export type PaymentMethod = 'mpesa' | 'bank' | 'card' | 'cash' | 'wallet'

export interface PaymentInitiation {
  amount: number
  currency: string
  method: PaymentMethod
  payee: string
  reference: string
  description?: string
}

export interface ProviderResult {
  /** Provider-side reference for the attempted transfer. */
  providerRef: string
  /** Human-readable status — 'pending' means awaiting the provider's async confirmation. */
  status: 'succeeded' | 'failed' | 'pending'
  /** true = this rail recorded workflow only — no real money moved on it. */
  simulated: boolean
  /** Honest detail line for the audit trail / UI toast. */
  detail: string
  /**
   * FAILED initiation whose outcome could NOT be determined (issue #211):
   * true only when NO usable provider answer was seen — the HTTP request
   * threw (timeout / unreachable) or the 2xx body was unparseable. In that
   * window Safaricom may still have accepted the push (and the customer may
   * still confirm it), so the wallet service records an unresolved-initiation
   * row instead of trusting 'failed' as final. An HTTP answer — even an
   * error status — is a definitive outcome and stays false. Optional and
   * absent on the simulated rails (their failures are always definitive).
   */
  outcomeUnknown?: boolean
}

/**
 * The provider contract every rail implements (spec §40):
 *   initiatePayment — start an outbound transfer to a payee
 *   verifyPayment   — confirm a previously initiated transfer settled
 *   refund          — reverse a settled transfer (provider-side)
 */
export interface PaymentProvider {
  readonly id: string
  readonly label: string
  /** Honest capability line shown in UI copy. */
  readonly integrationNote: string
  initiatePayment(input: PaymentInitiation): Promise<ProviderResult>
  verifyPayment(providerRef: string): Promise<ProviderResult>
  refund(providerRef: string, amount: number): Promise<ProviderResult>
}

/**
 * Pseudo-random provider-style reference — clearly NOT a real rail receipt.
 * MD-4 (#350): the suffix is drawn from the shared CSPRNG seam
 * (src/shared/ids.ts), never Math.random — the shape stays SIM-<rail>-XXXXXXXX
 * but the draw is unpredictable.
 */
function simulatedRef(prefix: string): string {
  return `SIM-${prefix}-${randomReferenceSuffix()}`
}

/**
 * The simulated rail (spec §40). Every result is labelled `simulated: true` —
 * this records workflow, it never pretends to move real money through a
 * licensed rail.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly id: string
  readonly label: string
  readonly integrationNote = 'Simulated rail — no licensed provider is integrated (workflow + ledger only)'

  constructor(id: string, label: string) {
    this.id = id
    this.label = label
  }

  async initiatePayment(input: PaymentInitiation): Promise<ProviderResult> {
    if (!(input.amount > 0)) {
      return {
        providerRef: simulatedRef(this.prefix()),
        status: 'failed',
        simulated: true,
        detail: `Rejected ${input.method} transfer of ${input.amount} — amount must be positive`,
      }
    }
    return {
      providerRef: simulatedRef(this.prefix()),
      status: 'succeeded',
      simulated: true,
      detail: `Simulated ${this.label} transfer of KSh ${Math.round(input.amount).toLocaleString('en-KE')} to ${input.payee} (ref ${input.reference}) — recorded, no real money moved`,
    }
  }

  async verifyPayment(providerRef: string): Promise<ProviderResult> {
    return {
      providerRef,
      status: 'succeeded',
      simulated: true,
      detail: `Simulated verification — ${providerRef} is recorded as settled on the simulated rail`,
    }
  }

  async refund(providerRef: string, amount: number): Promise<ProviderResult> {
    return {
      providerRef,
      status: 'succeeded',
      simulated: true,
      detail: `Simulated refund of KSh ${Math.round(amount).toLocaleString('en-KE')} against ${providerRef} — recorded on the ledger`,
    }
  }

  private prefix(): string {
    return this.id.slice(0, 4).toUpperCase()
  }
}

/** The internal escrow rail — money moves inside MjengoOS's own ledger. */
export class EscrowWalletProvider implements PaymentProvider {
  readonly id = 'wallet'
  readonly label = 'Escrow wallet (internal ledger)'
  readonly integrationNote = 'Internal ledger movement — escrow funds held for the project, no external rail involved'

  async initiatePayment(input: PaymentInitiation): Promise<ProviderResult> {
    return {
      providerRef: simulatedRef('WALT'),
      status: 'succeeded',
      simulated: true,
      detail: `Escrow release of KSh ${Math.round(input.amount).toLocaleString('en-KE')} to ${input.payee} — internal ledger movement (ref ${input.reference})`,
    }
  }

  async verifyPayment(providerRef: string): Promise<ProviderResult> {
    return {
      providerRef,
      status: 'succeeded',
      simulated: true,
      detail: `Escrow movement ${providerRef} is verifiable from the double-entry ledger`,
    }
  }

  async refund(providerRef: string, amount: number): Promise<ProviderResult> {
    return {
      providerRef,
      status: 'succeeded',
      simulated: true,
      detail: `Escrow refund of KSh ${Math.round(amount).toLocaleString('en-KE')} against ${providerRef} — posted as a reversal on the internal ledger`,
    }
  }
}

// ---- registry (getProvider) ----

/**
 * Stateless rails, instantiated once (they hold no env or token state). The
 * 'mpesa' entry is the fail-closed fallback — the REAL Daraja provider is
 * resolved per call in getProvider when its env set is complete.
 */
const STATIC_REGISTRY: Record<string, PaymentProvider> = {
  mpesa: new SimulatedProvider('mpesa', 'M-Pesa (simulated)'),
  bank: new SimulatedProvider('bank', 'Bank transfer (simulated)'),
  card: new SimulatedProvider('card', 'Card (simulated)'),
  cash: new SimulatedProvider('cash', 'Cash (recorded)'),
  wallet: new EscrowWalletProvider(),
}

/**
 * Resolve the provider for a payment method — the single seam (spec §40).
 * 'mpesa' routes to the Daraja provider ONLY when the full DARAJA_* env set
 * is present (getDarajaProvider reads env at call time and caches the
 * instance + OAuth token per config); anything missing fail-closes to the
 * simulated M-Pesa rail — the default deployment, unchanged. Unknown methods
 * also land on the SIMULATED mpesa rail (never an env-gated real one).
 */
export function getProvider(method: string): PaymentProvider {
  const key = String(method ?? '').toLowerCase()
  if (key === 'mpesa') {
    return getDarajaProvider() ?? STATIC_REGISTRY.mpesa
  }
  return STATIC_REGISTRY[key] ?? STATIC_REGISTRY.mpesa
}

/** Every registered provider id (for guards / UI copy). */
export const PROVIDER_METHODS = ['mpesa', 'bank', 'card', 'cash', 'wallet'] as PaymentMethod[]
