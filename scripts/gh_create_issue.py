#!/usr/bin/env python3
"""Create a GitHub issue on Youngshark-Technologies/Mjengo-OS.

Usage: gh_create_issue.py <title-file> <body-file> [labels.csv]
Reads PAT from /home/z/my-project/upload/sharkpush.txt (line 1).
Prints the issue URL and number on success.
"""
import sys, json, re, urllib.request

def decode_escapes(s):
    """Turn literal \\uXXXX sequences into real characters."""
    return re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), s)

REPO = 'Youngshark-Technologies/Mjengo-OS'
PAT_FILE = '/home/z/my-project/upload/sharkpush.txt'

def pat():
    with open(PAT_FILE, 'r', encoding='utf-8') as f:
        return f.readline().strip().strip('\r\n ')

def api(method, path, payload=None):
    url = f'https://api.github.com/repos/{REPO}/{path}'
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
        body = e.read().decode()
        return e.code, {'error': body[:500]}

def main():
    title = decode_escapes(open(sys.argv[1], encoding='utf-8').read().strip())
    body = decode_escapes(open(sys.argv[2], encoding='utf-8').read())
    payload = {'title': title, 'body': body}
    if len(sys.argv) > 3 and sys.argv[3].strip():
        payload['labels'] = [x.strip() for x in sys.argv[3].split(',') if x.strip()]
    status, resp = api('POST', 'issues', payload)
    if status == 201:
        print(f"CREATED #{resp['number']} {resp['html_url']}")
    else:
        print(f'FAILED {status}: {resp}')
        sys.exit(1)

if __name__ == '__main__':
    main()
