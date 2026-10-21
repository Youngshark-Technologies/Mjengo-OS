#!/usr/bin/env python3
"""Disable CI workflows (owner instruction, refs #98 billing lock).

Strategy: replace push/pull_request triggers with workflow_dispatch-only,
keeping the ORIGINAL trigger block as a YAML comment for trivial restore.
Byte-safe: exact-match replacement with hard assertions; YAML-parse verify.
Display-artifact aware: never paste trigger lines from tool output — the
original blocks below were captured via grep-count proof (branches: [main]).
"""
import re, sys, hashlib
import yaml  # pyyaml available? fallback to manual check below

BASE = '/home/z/my-project/mjengoos/.github/workflows/'
FILES = ['ci.yml', 'test.yml', 'docker.yml', 'publish.yml']

COMMENT_MAIN = """# WORKFLOWS SUSPENDED (2026-10-13): GitHub Actions is billing-locked
# account-wide (#98, owner action pending). Every automatic run fails at
# startup in 3-9s, so push/PR triggers are parked to keep the Actions tab
# clean and avoid failed-run noise. Manual workflow_dispatch stays wired.
# To restore: uncomment the original trigger block once #98 is resolved.
"""

COMMENT_PUBLISH = """# PUBLISH SUSPENDED (2026-10-13): GitHub Actions is billing-locked
# account-wide (#98, owner action pending). Automatic tag-push publishes are
# parked; manual workflow_dispatch stays wired for when billing is restored.
# To restore: uncomment the original trigger block once #98 is resolved.
"""

# Exact original on: blocks (byte-verified via grep 'branches: \[main\]' counts)
ORIG = {
    'ci.yml': "on:\n  push:\n    branches: [main]\n  pull_request:\n",
    'test.yml': "on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n",
    'docker.yml': "on:\n  push:\n    branches: [main]\n  pull_request:\n",
    'publish.yml': "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n",
}

def commented(block):
    return ''.join('# ' + l if l.strip() else '#\n' for l in block.splitlines(True))

NEW = {
    'ci.yml': COMMENT_MAIN + commented(ORIG['ci.yml']) + "on:\n  workflow_dispatch:\n",
    'test.yml': COMMENT_MAIN + commented(ORIG['test.yml']) + "on:\n  workflow_dispatch:\n",
    'docker.yml': COMMENT_MAIN + commented(ORIG['docker.yml']) + "on:\n  workflow_dispatch:\n",
    'publish.yml': COMMENT_PUBLISH + commented(ORIG['publish.yml']) + "on:\n  workflow_dispatch:\n",
}

fails = []
for f in FILES:
    p = BASE + f
    s = open(p, 'r', encoding='utf-8').read()
    if ORIG[f] not in s:
        fails.append(f + ': original on: block NOT found byte-exact'); continue
    if s.count(ORIG[f]) != 1:
        fails.append(f + ': on: block occurs != 1'); continue
    s2 = s.replace(ORIG[f], NEW[f], 1)
    # hard post-conditions
    assert '  workflow_dispatch:' in s2, f
    # active (uncommented) triggers must be workflow_dispatch only
    on_zone = re.search(r'^on:\n((?:[ \t]+.*\n|!.*\n)*)', s2, re.M).group(0)
    for banned in ('  push:', '  pull_request:', '  schedule:'):
        # only flag if present as ACTIVE yaml keys in the on: zone (not '# ')
        active = [l for l in on_zone.splitlines() if l.startswith(banned)]
        if active:
            fails.append(f + ': active trigger remains: ' + banned)
    try:
        d = yaml.safe_load(s2)
        assert isinstance(d, dict) and 'on' in d or True in d, f + ': yaml on-key'
        # pyyaml 1.1 parses bare `on` as boolean True — accept both
        trig = d.get('on', d.get(True))
        assert trig is not None and 'workflow_dispatch' in trig, f + ': workflow_dispatch missing'
        assert 'push' not in trig and 'pull_request' not in trig, f + ': push/pr still active'
    except Exception as e:
        fails.append(f + ': YAML verify FAILED: ' + repr(e)); continue
    open(p, 'w', encoding='utf-8').write(s2)
    print('OK  ', f, 'sha16:', hashlib.sha256(s2.encode()).hexdigest()[:16])

if fails:
    print('\nFAILURES:'); [print(' -', x) for x in fails]; sys.exit(1)
print('\nAll 4 workflows disabled (workflow_dispatch-only). YAML verified.')
