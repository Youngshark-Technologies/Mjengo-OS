#!/usr/bin/env python3
"""Merge a PR and delete its branch. Usage: gh_merge_pr.py <number> [subject]"""
import sys, json, urllib.request
sys.path.insert(0, '/home/z/my-project/scripts')
from gh_create_issue import pat

REPO = 'Youngshark-Technologies/Mjengo-OS'

def api(method, path, payload=None):
    url = f'https://api.github.com/{path}'
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'token {pat()}',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'mjengo-pipeline',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode()[:500]}

def main():
    n = sys.argv[1]
    subject = sys.argv[2] if len(sys.argv) > 2 else None
    payload = {'merge_method': 'merge'}
    if subject:
        payload['commit_title'] = subject
    status, resp = api('PUT', f'repos/{REPO}/pulls/{n}/merge', payload)
    print(f'merge: {status} {json.dumps(resp)[:300]}')
    if status == 200:
        # delete remote branch
        _, ref = api('GET', f'repos/{REPO}/git/ref/heads/{resp.get("branch", "")}')
        head = resp.get('sha') and None
        # pull the head ref from the PR
        s2, pr = api('GET', f'repos/{REPO}/pulls/{n}')
        if s2 == 200:
            ref_name = pr['head']['ref']
            s3, _ = api('DELETE', f'repos/{REPO}/git/refs/heads/{ref_name}')
            print(f'branch {ref_name} delete: {s3}')
        sys.exit(0)
    sys.exit(1)

if __name__ == '__main__':
    main()
