/**
 * The WhatsApp simulation content contract (session-2 register row:
 * "WhatsApp panel server-fed content").
 *
 * THE SPLIT (mirrors the honest-seam discipline, cf. the #140 USSD i18n
 * landing): the panel's SIMULATED CONVERSATION CONTENT — the line's opening
 * message, the keyword grammar, the HELP reply — is CANNED ON THE SERVER and
 * served by GET /api/whatsapp?view=simulation; the panel renders exactly what
 * the route returns and keeps NO client-side copy of it. View-only UI chrome
 * (titles, badges, explainer, aria labels) stays in the frontend dicts
 * (EN/SW) like every other surface.
 *
 * This module is the ONE shared type for that seam (server-safe, no
 * 'use client' — the src/shared/supplier-actions.ts convention) so the route,
 * the panel and the tests cannot drift. The CONTENT itself lives only in the
 * route file — importing it into a client bundle would put the canned strings
 * right back client-side, which is exactly what this register row closed.
 */
export interface WhatsappSimulationContent {
  /** The line's opening message, exactly as a handset would receive it
   *  (sim footer included — the same honesty label every POST reply carries). */
  greeting: string
  /** The keyword grammar the POST handler matches (uppercased, whole
   *  message). The panel renders these as the quick-reply chips and the
   *  composer placeholder — the grammar is the SERVER's, never re-listed. */
  keywords: string[]
  /** The reply a HELP text gets — the line's own usage text, served so the
   *  panel's keywords reference shows the same words the line answers with. */
  helpText: string
}

/** The GET query param that selects the JSON simulation view. */
export const WHATSAPP_SIMULATION_VIEW = 'simulation'
