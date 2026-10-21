// MJG-025 — open the lineage-reconciliation PR on Youngshark-Technologies/Mjengo-OS.
// Reads GH_TOKEN from env; never prints it. Exits 0 with the PR URL on success.
import { request } from 'node:https'

const REPO = 'Youngshark-Technologies/Mjengo-OS'
const HEAD = 'sandbox/prod-readiness-2026-10-21'
const BASE = 'main'

const body = `# [LAUNCH] Production-readiness state of the sandbox lineage — reconciliation decision required

## What this PR is
The engineering organization completed the production-launch program (MJG-001..025) in the engineering sandbox: complete demo/test data removal, production hardening, and independent validation. This branch publishes the **validated final tree** for team review. **It intentionally does not force-push or overwrite \`main\`.**

## Why a PR instead of a direct push to \`main\`
Remote \`main\` (774f06ec) and the sandbox lineage have **unrelated git histories** (no merge-base). The remote carries PR lineage #407–413 and a materially different, larger implementation state (Supabase-based design docs, \`prisma/seed-all.ts\`, ~457 src files / ~+89k lines not present in the sandbox lineage), while the sandbox holds the fully validated Prisma/SQLite product this launch program hardened. Overwriting either side destroys work (data-loss release blocker), so the decision is escalated here with full evidence.

## The two reconciliation options
1. **Adopt the sandbox lineage as the product** (recommended if the Supabase line is superseded): merge this branch so \`main\`'s content becomes this validated tree while preserving remote history in the graph (history-adopt merge). Carry remote #409's plain-\`next build\` Vercel fix into \`package.json\` during reconciliation.
2. **Keep remote \`main\` authoritative**: selectively adapt the sandbox capabilities (MJG-016..025 artifacts: data-audit/wipe tooling, backup/restore kits, deployment kit, replayable 21-case API suite, security headers, runbooks).

## What the sandbox lineage contains (evidence in-tree)
- 25 issues DONE — registry \`issues/INDEX.md\`; full evidence trail in \`worklog.md\` (issue → branch → gates → merge → release)
- 23 org-scoped API routes; server-side role gates; segregation red lines regression-tested (self-verify 403, supervisor-approve 403)
- **Production data wipe executed**: 62 → 0 rows across 18 tables, \`integrity_check ok\`, 0 orphans, reversible pre-wipe backup — see \`docs/PRODUCTION_LAUNCH_REPORT.md\`
- Hardening: type-enforced builds (\`ignoreBuildErrors:false\`), strict mode, security headers verified live; \`secure\` cookies in production
- QA gates: 21-case replayable API suite (63 assertions) green; smoke green on the empty production DB; lint + tsc green
- Kits: \`scripts/db-{backup,restore,audit-counts}.ts\`, guarded \`scripts/db-reset-with-backup.sh\`, \`scripts/smoke.sh\`, Dockerfile + entrypoint, DEPLOYMENT/BACKUPS runbooks

## Security notes
- A GitHub token was temporarily tracked in the sandbox lineage's history (\`upload/sharkpush.txt\`, present since the initial commit); **this branch excludes it** (squashed tree verified: zero secret-pattern hits). Full-history pushes are declined by push protection for exactly this reason. **Rotate that token.**
- \`upload/\`, \`examples/\`, \`tool-results/\` are gitignored going forward.

## Vercel redeploy
Blocked on this reconciliation decision: once an option is chosen and merged, Vercel's git integration can deploy (the repo is Vercel-connected per PRs #408/#409). Note remote #409's plain-\`next build\` fix must be carried into whichever tree ships. SQLite is ephemeral on serverless — prefer the Docker/bare-metal path or a hosted DB for production data.

---
Requested reviewers: repository maintainers. This PR does not modify \`main\`.`

function post(path: string, payload: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: 'api.github.com', path, method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GH_TOKEN ?? ''}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'mjengo-launch-bot',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw || '{}') }))
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function main(): Promise<void> {
  const created = await post(`/repos/${REPO}/pulls`, { title: '[LAUNCH][DECISION REQUIRED] Production-readiness sandbox lineage (MJG-001..025) — lineage reconciliation before main/Vercel', head: HEAD, base: BASE, body, maintainer_can_modify: false })
  if (created.status === 201) {
    const n = created.data.number, url = created.data.html_url
    console.log(`PR #${n} opened: ${url}`)
    return
  }
  // Fallback: PR may already exist for this head
  if (created.status === 422 && JSON.stringify(created.data).includes('A pull request already exists')) {
    console.log('PR already exists for this head — fetching its URL')
    const list = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: 'api.github.com', path: `/repos/${REPO}/pulls?head=${REPO}:${HEAD}&state=open`, method: 'GET', headers: { 'Authorization': `Bearer ${process.env.GH_TOKEN ?? ''}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'mjengo-launch-bot' } }, (res) => { let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw || '[]') })) }); req.on('error', reject); req.end()
    })
    const arr = list.data as unknown as Array<{ number: number; html_url: string }>
    if (Array.isArray(arr) && arr.length > 0) { console.log(`PR #${arr[0].number} exists: ${arr[0].html_url}`); return }
  }
  console.error(`PR creation FAILED (${created.status}):`, JSON.stringify(created.data).slice(0, 400))
  process.exit(1)
}

main().catch((e: unknown) => { console.error('FAILED:', e); process.exit(1) })
