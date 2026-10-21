#!/usr/bin/env python3
"""Create a PR on Youngshark-Technologies/Mjengo-OS.

Usage: gh_create_pr.py <head-branch> <base-branch> <title-file> <body-file>
Prints PR URL and number on success.
"""
import sys, json, urllib.request
sys.path.insert(0, '/home/z/my-project/scripts')
from gh_create_issue import pat, decode_escapes

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
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode()[:500]}

def main():
    head, base = sys.argv[1], sys.argv[2]
    title = decode_escapes(open(sys.argv[3], encoding='utf-8').read().strip())
    body = decode_escapes(open(sys.argv[4], encoding='utf-8').read())
    status, resp = api('POST', f'repos/{REPO}/pulls', {
        'title': title, 'head': head, 'base': base, 'body': body,
    })
    if status == 201:
        print(f"CREATED PR #{resp['number']} {resp['html_url']}")
    else:
        print(f'FAILED {status}: {resp}')
        sys.exit(1)

if __name__ == '__main__':
    main()
