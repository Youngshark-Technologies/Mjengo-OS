// OPEN-ISSUES-06 — publication PR: open release/open-issues-06 -> main, then merge (merge commit).
// Reads GH_TOKEN from env; never prints it. Prints PR number, URL and merge SHA on success.
import { request } from 'node:https'

const REPO = 'Youngshark-Technologies/Mjengo-OS'
const HEAD = 'release/open-issues-06'
const BASE = 'main'

const body = `# Publication: validated product lineage, release OPEN-ISSUES-06 (MJG-030..070)

**Purpose.** Fast-forward-equivalent publication of the validated lineage per the recorded product decision (PR #414, MJG-031): sandbox lineage is the product. \`main\`'s content becomes the release tree; remote history is preserved in the graph (merge commit; head branch is a descendant of current \`main\`).

## Scope (since current \`main\` = f8e8c4e)
- **Partner access model** (MJG-030/035/036): CONSTRUCTOR / SUPPLIER / LOGISTICS org types, partner self-registration, supplier PO-acknowledge + shipment logging, logistics delivery-task model; migration \`20261113120000_partner_phase2\`
- **API/security hardening** (MJG-044..065): org-type guards on all constructor-domain writes, transactional + predicate-guarded payment approve, rightmost-XFF rate-limit keys, bounded limiter memory, bounded lists, session pruning, terminal FSM guards, tenancy regressions
- **Deploy & docs** (MJG-037..041/046/057): vercel.json beforeFiles \`/api\` proxy, render.yaml, pinned \`package-lock.json\`, \`engines>=20\`, dormant CI workflow, DEPLOYMENT/BACKUPS runbooks
- **Frontend resilience** (MJG-049/055): route error boundaries, boot-failure retry, \`#get-started\`→REGISTER / \`#signin\`→LOGIN deep links, radiogroup a11y
- **Release engineering** (MJG-068..070): §12 Engineering Execution Report (\`docs/ENGINEERING_EXECUTION_REPORT.md\`), history-level secret scrub of the publication range (daemon-era PAT blobs removed; tips byte-identical; FF preserved)

## Evidence (all green on the released tree)
- \`bun run lint\` + \`bunx tsc --noEmit\` — PASS
- SQLite API suite: **43/43 pass, 228 assertions** (twice: RC2 + close-out)
- Postgres gate: **43/43 pass** — \`prisma migrate deploy\` replayed all 3 versioned migrations on embedded Postgres (first attempt)
- Browser E2E golden paths (isolated throwaway DB): landing, \`#get-started\` REGISTER mode with org-type radios, register→shell, logout, \`#signin\` LOGIN, login→dashboard; zero page errors
- Secret scan on tracked tree: 0 hits; GitHub push protection: PASSES (scrubbed history)
- Traceability: \`issues/INDEX.md\` (69/70 DONE; only MJG-069 P3 UX polish open) + \`worklog.md\` full journal

## Security notes
- Two daemon-era GitHub PATs existed only in unpushed history commits; scrubbed in MJG-070 (push protection re-verified). Tokens were never published. Rotation of both remains recommended hygiene (MJG-047).

---
Merges as a single merge commit preserving remote lineage. Head branch deleted after merge.`

function req(method: string, path: string, payload?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const data = payload === undefined ? undefined : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const r = request(
      { hostname: 'api.github.com', path, method,
        headers: {
          'Authorization': `Bearer ${process.env.GH_TOKEN ?? ''}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'mjengo-release-bot',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw || '{}') }))
      },
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

async function main(): Promise<void> {
  const created = await req('POST', `/repos/${REPO}/pulls`, { title: 'Publication: validated lineage OPEN-ISSUES-06 (partner model, hardening, deploy kit, §12 report, scrubbed history)', head: HEAD, base: BASE, body, maintainer_can_modify: false })
  let num: number | undefined
  if (created.status === 201) {
    num = created.data.number as number
    console.log(`PR #${num} opened: ${created.data.html_url}`)
  } else if (created.status === 422 && JSON.stringify(created.data).includes('A pull request already exists')) {
    const list = await req('GET', `/repos/${REPO}/pulls?head=${REPO}:${HEAD}&state=open`)
    const arr = list.data as unknown as Array<{ number: number; html_url: string }>
    if (Array.isArray(arr) && arr.length > 0) { num = arr[0].number; console.log(`PR #${num} already open: ${arr[0].html_url}`) }
  }
  if (!num) {
    console.error(`PR creation FAILED (${created.status}):`, JSON.stringify(created.data).slice(0, 500))
    process.exit(1)
  }
  const merged = await req('PUT', `/repos/${REPO}/pulls/${num}/merge`, {
    commit_title: `Merge PR #${num}: publication OPEN-ISSUES-06 — validated lineage (MJG-030..070): partner model + phase-2, API/security hardening, deploy kit, §12 report, scrubbed publication history. Evidence: SQLite 43/43 (228) ×2, PG 43/43 with migrations replayed, browser E2E green, secret scan 0 hits, push-protection clean.`,
    commit_message: 'Content decision recorded in PR #414 (MJG-031): sandbox lineage is the product. Remote history preserved in graph via merge commit. Registry issues/INDEX.md 69/70 DONE (open: MJG-069 P3).',
    merge_method: 'merge',
  })
  if (merged.status === 200) {
    console.log(`MERGED as ${merged.data.sha} (merge commit); PR #${num} closed`)
  } else {
    console.error(`MERGE FAILED (${merged.status}):`, JSON.stringify(merged.data).slice(0, 500))
    process.exit(2)
  }
}

main().catch((e: unknown) => { console.error('FAILED:', e); process.exit(1) })
