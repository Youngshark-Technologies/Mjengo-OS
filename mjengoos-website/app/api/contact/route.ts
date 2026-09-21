import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { SITE } from "@/lib/site";
import {
  hasLegacyPlaintextContactPii,
  resolveContactPiiChannel,
  sealContactSubmission,
} from "../../../lib/contact-pii.mjs";

/**
 * Contact / demo-request endpoint (§45), hardened per audit MW-10:
 *
 *  · Same-site Origin/Referer gate when the browser sends one (curl/tests
 *    send neither and pass — they are not browser CSRF/abuse vectors).
 *  · Rate limit (issue #131 / WD-1): 5 submissions per hour PER VISITOR
 *    when TRUST_PROXY is set — keyed on the proxy-appended (LAST)
 *    x-forwarded-for entry, mirroring the main app's rate-limit.ts
 *    TRUST_PROXY pattern (with exactly one appending reverse proxy in front,
 *    the last XFF value is that proxy's view of the client; the header is
 *    client-spoofable without the flag, so it is ignored then). Two layers:
 *      · per-visitor bucket — MAX_PER_HOUR (5) when keyed per client;
 *      · GLOBAL backstop bucket — GLOBAL_MAX_PER_HOUR (200) across ALL
 *        visitors, which is also the effective cap of the default
 *        no-TRUST_PROXY posture: all traffic then shares that one bucket,
 *        so a legitimate launch burst no longer 429s everyone at 5/hour,
 *        while an unconfigured deploy still fails closed against a flood.
 *    429s say which layer tripped (`reason`: "rate_limited_visitor" vs
 *    "rate_limited_global") and the global layer logs a warning — a burst
 *    that drops leads is visible in `docker compose logs website`.
 *  · Restart persistence: DELIBERATELY declined (issue #131 AC). The
 *    counters are in-memory, so a restart grants a fresh window — a
 *    bounded relaxation (≤ 5/hr per visitor, ≤ 200/hr globally), not a
 *    bypass. The website is a stateless marketing app with no database;
 *    porting the main app's opt-in SQLite rate-limit store (PR #68) would
 *    add a writable-DB dependency to a container whose only state is the
 *    submissions file. Revisit only if the site grows multi-instance.
 *  · Raw-body size cap (~16KB) checked BEFORE JSON.parse (Content-Length
 *    honored, actual bytes re-verified after reading) — same shape as the
 *    main app's route-kit audit-#4 fix.
 *  · Honeypot field "companyWebsite": a visually-hidden input humans never
 *    fill; a filled one is a bot and the submission is rejected.
 *  · data/submissions.json is capped at 500 stored entries (oldest dropped
 *    on write) so the gitignored runtime PII file cannot grow unbounded —
 *    and since issue #131 every eviction logs a warning with the count:
 *    dropped leads are silent no longer (see DEPLOYMENT.md §6.3).
 *  · Contact-PII encryption at rest (MD-3 / issue #362): every PII field
 *    of a submission (name, email, phone, organization, role, country,
 *    projectType, message) is sealed with AES-256-GCM under
 *    CONTACT_PII_KEY before the file is written — the volume, its tar
 *    backups and any leaked copy rest as ciphertext without the key.
 *    `id`/`ts`/`source` stay plaintext on purpose so the store remains
 *    inspectable for counts, the 500-cap eviction order and erasure
 *    targeting without it. Production with no key (or a malformed one)
 *    FAILS CLOSED — 503, nothing written, one loud error per process
 *    (the VAPID_SUBJECT / issue #354 posture); dev/test seals under the
 *    labeled dev-fallback key with one warning. Legacy plaintext rows
 *    are re-sealed by a write-path sweep: the first submission after the
 *    upgrade seals the whole file, and sealed rows are never re-sealed
 *    (no churn). Retrieval + the erasure write-back: the site's
 *    scripts/decrypt-leads.mjs CLI (DEPLOYMENT.md §6.3).
 *
 * Still no third-party service is contacted; validation stays server-side.
 */

interface Submission {
  id: string;
  ts: string;
  source: string;
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  role?: string;
  country?: string;
  projectType?: string;
  message?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+0-9 ()-]{7,20}$/;

/** ~16KB — real form payloads are well under 2KB. */
const MAX_BODY_BYTES = 16 * 1024;
/** Retention cap for data/submissions.json (gitignored runtime file). */
const MAX_STORED_SUBMISSIONS = 500;

const REQUESTS = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** Per-visitor cap (TRUST_PROXY set — see the file header). */
const MAX_PER_HOUR = 5;
/**
 * Global backstop (issue #131): one shared ceiling per hour across ALL
 * visitors. It bounds abuse even when keying is per-visitor (floods of
 * distinct keys) and it is the cap of the shared bucket used when
 * TRUST_PROXY is unset, so the default posture tolerates launch bursts
 * (200 leads/hour) instead of 429ing everyone after five.
 */
const GLOBAL_MAX_PER_HOUR = 200;
/** Bucket key for the shared/global layer. */
const GLOBAL_KEY = "global";

/** True when TRUST_PROXY is explicitly enabled (non-empty, not 0/false). */
function isTrustProxyEnabled(): boolean {
  const v = process.env.TRUST_PROXY;
  if (!v || !v.trim()) return false;
  const lower = v.trim().toLowerCase();
  return lower !== "0" && lower !== "false";
}

/**
 * Rate-limit key (see the file header): with TRUST_PROXY set we key on the
 * proxy-appended (LAST) x-forwarded-for entry — the main app's rate-limit.ts
 * TRUST_PROXY pattern; without it the spoofable header is ignored entirely
 * and all traffic shares the global bucket (capped at GLOBAL_MAX_PER_HOUR,
 * not 5 — bursts survive, floods still fail closed).
 */
function rateLimitKey(request: Request): string {
  if (!isTrustProxyEnabled()) return GLOBAL_KEY;
  const values = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? `ip:${values[values.length - 1]}` : "anon";
}

/** Record a hit for `key` in the rolling hour; returns the post-hit count. */
function recordHit(key: string): number {
  const now = Date.now();
  const hits = (REQUESTS.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  REQUESTS.set(key, hits);
  return hits.length;
}

/**
 * Record this request against `key` and the global backstop, then report
 * which layer (if any) tripped: "visitor" (this client exceeded 5/hr —
 * only possible with TRUST_PROXY keying), "global" (the shared 200/hr
 * ceiling), or null (allowed).
 */
function rateLimitStatus(key: string): "visitor" | "global" | null {
  const perKey = recordHit(key);
  if (key === GLOBAL_KEY) {
    return perKey > GLOBAL_MAX_PER_HOUR ? "global" : null;
  }
  if (perKey > MAX_PER_HOUR) return "visitor";
  return recordHit(GLOBAL_KEY) > GLOBAL_MAX_PER_HOUR ? "global" : null;
}

/**
 * Same-site Origin/Referer gate (MW-10). Browsers send Origin on cross-site
 * POST fetches; when either header is present its host must match a host we
 * know we are served from: the request's own Host, the x-forwarded-host the
 * app's /website proxy adds, or the configured public origin. Absent both
 * headers (curl, tests, health probes) → allowed.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) return true;

  const allowedHosts = new Set<string>();
  for (const header of ["host", "x-forwarded-host"]) {
    const host = request.headers.get(header)?.toLowerCase();
    if (host) allowedHosts.add(host);
  }
  try {
    allowedHosts.add(new URL(SITE.url).host.toLowerCase());
  } catch {
    // SITE.url is normalized in lib/site.ts; skip on a parse failure.
  }

  const candidates: string[] = [];
  for (const headerValue of [origin, referer]) {
    if (!headerValue) continue;
    try {
      candidates.push(new URL(headerValue).host.toLowerCase());
    } catch {
      return false; // present but unparseable (e.g. "Origin: null") → reject
    }
  }
  return candidates.every((host) => allowedHosts.has(host));
}

function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validate(body: Record<string, unknown>): { errors: Record<string, string>; data: Omit<Submission, "id" | "ts"> } {
  const errors: Record<string, string> = {};

  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = str(body.phone, 20);
  const organization = str(body.organization, 80);
  const role = str(body.role, 40);
  const country = str(body.country, 60);
  const projectType = str(body.projectType, 60);
  const message = str(body.message, 2000);
  const source = str(body.source, 40) || "contact";

  if (name.length < 2) errors.name = "Please enter your name (at least 2 characters).";
  if (!EMAIL_RE.test(email)) errors.email = "Please enter a valid email address.";
  if (phone && !PHONE_RE.test(phone)) errors.phone = "Please enter a valid phone number.";
  if (source !== "signup" && message.length < 10) {
    errors.message = "Please tell us a little about your project (at least 10 characters).";
  }
  if (source === "signup" && !role) {
    errors.role = "Please choose your role.";
  }

  return { errors, data: { source, name, email, phone: phone || undefined, organization: organization || undefined, role: role || undefined, country: country || undefined, projectType: projectType || undefined, message: message || undefined } };
}

export async function POST(request: Request) {
  if (!originAllowed(request)) {
    return NextResponse.json(
      { ok: false, error: "This form only accepts submissions from the MjengoOS website." },
      { status: 403 },
    );
  }

  // Contact-PII key gate (issue #362 / MD-3), BEFORE the rate limiter and
  // any body read: with no usable key this endpoint cannot store anything
  // it is allowed to store, so it refuses — 503, honest copy for the
  // visitor, the operator detail in the once-per-process console.error
  // emitted by resolveContactPiiChannel(). Production fails closed on an
  // unset key; a malformed key refuses in EVERY runtime (a bad key must
  // never seal leads it cannot decrypt back).
  const piiChannel = resolveContactPiiChannel();
  if (piiChannel.refused) {
    return NextResponse.json(
      {
        ok: false,
        reason: `contact_pii_key_${piiChannel.problem}`,
        error: "We can't save your message right now — please try again a little later.",
      },
      { status: 503 },
    );
  }

  const key = rateLimitKey(request);
  const limited = rateLimitStatus(key);
  if (limited) {
    if (limited === "global") {
      // Visible operability (issue #131): the shared ceiling only trips on
      // a flood — say so in the logs, with the cap, right where it happens.
      console.warn(
        `[contact] global submission cap reached (${GLOBAL_MAX_PER_HOUR}/hour) — requests are being rejected; ` +
          (isTrustProxyEnabled()
            ? "per-visitor keying is ON (TRUST_PROXY set): this is aggregate load, not one visitor."
            : "per-visitor keying is OFF (TRUST_PROXY unset): all traffic shares one bucket — set TRUST_PROXY behind an appending proxy to key per visitor (see .env.example)."),
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          limited === "visitor"
            ? "Too many submissions from this address. Please try again later."
            : "We're receiving a lot of submissions right now — please try again in a little while.",
        reason: limited === "visitor" ? "rate_limited_visitor" : "rate_limited_global",
      },
      { status: 429 },
    );
  }

  // Raw-size cap BEFORE any parse (route-kit audit-#4 shape): honor the
  // declared Content-Length, then re-check the actual bytes — a lying client
  // still cannot push an oversized payload into JSON.parse.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That message is too large — please shorten it and try again." },
      { status: 413 },
    );
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That message is too large — please shorten it and try again." },
      { status: 413 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  // Honeypot: "companyWebsite" is a visually-hidden field humans never see
  // or fill. Anything in it means an automated submitter → reject quietly.
  if (str(body.companyWebsite, 100)) {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { errors, data } = validate(body);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  // The submission's PII fields are sealed BEFORE the first byte touches
  // disk (issue #362). The response returns the id only — it is not PII.
  const submission = sealContactSubmission(piiChannel.key, {
    id: `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...data,
  });

  try {
    const file = path.join(process.cwd(), "data", "submissions.json");
    let existing: Array<Record<string, unknown>> = [];
    try {
      existing = JSON.parse(await fs.readFile(file, "utf8")) as Array<Record<string, unknown>>;
      if (!Array.isArray(existing)) existing = [];
    } catch {
      // First submission — file doesn't exist yet.
    }
    // Write-path sweep (issue #362): any entry still resting in plaintext
    // (a legacy pre-#362 row, or an operator's plaintext write-back) is
    // sealed in the same write, so the store converges to fully encrypted
    // on the first submission after the upgrade. Fully sealed rows are
    // never revisited — steady-state writes do zero crypto on old entries.
    let sealedLegacy = 0;
    existing = existing.map((row) => {
      if (hasLegacyPlaintextContactPii(row)) {
        sealedLegacy += 1;
        return sealContactSubmission(piiChannel.key, row);
      }
      return row;
    });
    if (sealedLegacy > 0) {
      console.warn(
        `[contact] sealed ${sealedLegacy} legacy plaintext entr${sealedLegacy === 1 ? "y" : "ies"} ` +
          `during this write (issue #362 migration sweep) — the store is now fully encrypted at rest.`,
      );
    }
    existing.push(submission);
    // Retention cap (MW-10, kept verbatim by #362 — the 500-most-recent
    // count cap IS the documented live-file retention, §6.3/§7.2.1): keep
    // only the most recent entries so the contact data on disk stays
    // bounded. Since issue #131 every eviction is LOUD — dropped leads are
    // the one irreversible loss this endpoint can suffer, so operators get
    // a count in the logs (visible via `docker compose logs website`;
    // retrieval guide: DEPLOYMENT §6.3).
    if (existing.length > MAX_STORED_SUBMISSIONS) {
      const dropped = existing.length - MAX_STORED_SUBMISSIONS;
      console.warn(
        `[contact] submission cap reached — dropping ${dropped} oldest ` +
          `entr${dropped === 1 ? "y" : "ies"} (MAX_STORED_SUBMISSIONS=${MAX_STORED_SUBMISSIONS}); ` +
          `dropped leads are unrecoverable — retrieve the file soon (DEPLOYMENT.md §6.3).`,
      );
      existing = existing.slice(existing.length - MAX_STORED_SUBMISSIONS);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(existing, null, 2), "utf8");
  } catch (err) {
    console.error("[contact] failed to persist submission:", err);
    return NextResponse.json(
      { ok: false, error: "We couldn't save your message. Please try again in a moment." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id: submission.id });
}
