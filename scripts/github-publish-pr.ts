// Publication PR helper — MJG-071 generalized release flow (remote main is PR-protected).
// Usage: GH_TOKEN=<token> bun scripts/github-publish-pr.ts <head> <base> <title> <bodyFile>
//   head      branch pushed to remote containing the release commit (e.g. release/open-issues-07)
//   base      target branch, normally main
//   title     PR title (quote it)
//   bodyFile  path to a file with the PR body markdown
// With NO args falls back to the OPEN-ISSUES-06 publication (historical record).
// Reads GH_TOKEN from env; never prints it. Prints PR number, URL and merge SHA on success.
import { readFileSync } from 'node:fs'
import { request } from 'node:https'

const REPO = 'Youngshark-Technologies/Mjengo-OS'
const [headArg, baseArg, titleArg, bodyFileArg] = process.argv.slice(2)

const HEAD = headArg ?? 'release/open-issues-06'
const BASE = baseArg ?? 'main'
const TITLE = titleArg ?? 'Publication: validated lineage OPEN-ISSUES-06 (partner model, hardening, deploy kit, §12 report, scrubbed history)'
const BODY = bodyFileArg ? readFileSync(bodyFileArg, 'utf8') : `# Publication: validated product lineage, release OPEN-ISSUES-06 (MJG-030..070)\n\n(No body file supplied — see registry issues/INDEX.md + worklog.md for the full evidence trail.)`

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
  const created = await req('POST', `/repos/${REPO}/pulls`, { title: TITLE, head: HEAD, base: BASE, body: BODY, maintainer_can_modify: false })
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
    commit_title: `Merge PR #${num}: ${TITLE}`,
    commit_message: `Release merge (MJG-071 SOP): head ${HEAD} → ${BASE}. Evidence trail: issues/INDEX.md + worklog.md on the merged tree.`,
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
