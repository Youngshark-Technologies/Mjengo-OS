// @vitest-environment jsdom
/**
 * #137 (audit FE-8, issue #108's FE-3 pins) — RUNTIME dialog error
 * announcement: validation errors on the real dialogs are ANNOUNCED, i.e.
 * the input's aria-describedby target EXISTS in the accessibility tree and
 * the referenced node is an attached role="alert" live region.
 *
 * The static pins in tests/unit/frontend-a11y.test.ts assert the source
 * contains `aria-describedby={…'exp-amount-error'…}` and
 * `id="exp-amount-error" role="alert"` — this suite proves the PAIRING at
 * runtime: submit an empty form, then require getElementById(describedby)
 * to resolve to the mounted alert region (a refactor that renders the alert
 * in an unmounted portal, or key-mismatches the conditional id, fails here
 * while passing every source pin).
 *
 * Real components (Radix Dialog + framer-motion + the real i18n dict); the
 * only doubles are the submit handler and the open-state owner.
 */
import { describe, expect, it } from 'vitest'

import { ExpenseDialog } from '@/frontend/mjengo/expense-dialog'
import { CreateProjectDialog } from '@/frontend/mjengo/create-project-dialog'
import { I18nProvider } from '@/frontend/i18n/provider'
import { enDict } from '@/frontend/i18n/dicts/en'
import { byId, fireClick, fireInput, h, render } from './_helpers/react-render'

/** Click a dialog button by its (translated) visible text. */
const buttonByText = (text: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  )
  expect(found, `button containing "${text}" is rendered`).toBeTruthy()
  return found as HTMLButtonElement
}

describe('#137 runtime dialog errors: ExpenseDialog amount error is announced', () => {
  it('submitting an empty amount sets aria-invalid + an aria-describedby that RESOLVES to an attached role=alert region', async () => {
    render(
      h(I18nProvider, null,
        h(ExpenseDialog, { open: true, onOpenChange: () => {}, onSubmit: async () => true, submitting: false })),
    )

    const input = byId('exp-amount') as HTMLInputElement
    // Clean state first: no dangling describedby, no alert node, not invalid.
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(byId('exp-amount-error')).toBeNull()

    await fireClick(buttonByText(enDict['dialog.expense.submit']))

    // THE contract: describedby target exists and is the alert live region.
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBe('exp-amount-error')
    const alert = byId(describedBy as string)
    expect(alert, 'aria-describedby target is mounted (Radix portal included)').toBeTruthy()
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toBe(enDict['dialog.expense.error.amount'])
  })

  it('typing a valid amount clears the announcement (describedby + alert region unmount, aria-invalid false)', async () => {
    render(
      h(I18nProvider, null,
        h(ExpenseDialog, { open: true, onOpenChange: () => {}, onSubmit: async () => true, submitting: false })),
    )

    const input = byId('exp-amount') as HTMLInputElement
    await fireClick(buttonByText(enDict['dialog.expense.submit']))
    expect(byId('exp-amount-error')).toBeTruthy()

    await fireInput(input, '2500')
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(byId('exp-amount-error')).toBeNull()
  })
})

describe('#137 runtime dialog errors: CreateProjectDialog step-1 errors are announced', () => {
  it('continuing with an empty form announces BOTH the name and the budget error via describedby→alert pairs', async () => {
    render(
      h(I18nProvider, null,
        h(CreateProjectDialog, { open: true, onOpenChange: () => {}, onCreate: async () => true, submitting: false })),
    )

    await fireClick(buttonByText(enDict['dialog.createProject.continue']))

    for (const [inputId, errorId, message] of [
      ['pj-name', 'pj-name-error', enDict['dialog.createProject.error.name']],
      ['pj-budget', 'pj-budget-error', enDict['dialog.createProject.error.budget']],
    ] as const) {
      const input = byId(inputId) as HTMLInputElement
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(errorId)
      const alert = byId(errorId)
      expect(alert, `${errorId} is mounted`).toBeTruthy()
      expect(alert?.getAttribute('role')).toBe('alert')
      expect(alert?.textContent).toBe(message)
    }

    // Dates are pre-filled valid (today / +120d) → no dates error, and its
    // describedby stays absent rather than dangling.
    expect(byId('pj-dates-error')).toBeNull()
    expect(byId('pj-start')?.getAttribute('aria-describedby')).toBeNull()
  })
})
