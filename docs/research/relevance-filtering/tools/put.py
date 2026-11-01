# Appends labels to a JSON-lines file after checking them. Reads JSON lines on stdin:
#   {"q": 12, "labels": {}}                                   relevant to no profile
#   {"q": 13, "labels": {"chips": true}, "reasons": {"chips": "..."}}
#   {"q": 14, "labels": {"safety": null}, "reasons": {"safety": "..."}, "alternatives": {"safety": true}}
# Usage: python3 -I put.py <queue.json> <labels.jsonl> <profiles.json> [--skip <profile>]
import json, os, sys

queue_path, out_path, profiles_path = sys.argv[1:4]
skip = set(sys.argv[sys.argv.index('--skip') + 1:sys.argv.index('--skip') + 2]) if '--skip' in sys.argv else set()
allowed = {p['id'] for p in json.load(open(profiles_path))['profiles']} - skip
in_queue = {i['q'] for i in json.load(open(queue_path))}
done = set()
if os.path.exists(out_path):
    done = {json.loads(line)['q'] for line in open(out_path) if line.strip()}

rows, errors = [], []
for n, line in enumerate(sys.stdin, 1):
    if not line.strip():
        continue
    try:
        row = json.loads(line)
        q, labels = row['q'], row['labels']
        reasons, alternatives = row.get('reasons', {}), row.get('alternatives', {})
        assert q in in_queue, f'q {q} is not in this queue'
        assert q not in done and q not in {r['q'] for r in rows}, f'q {q} is already labelled'
        for profile, value in labels.items():
            assert profile in allowed, f'unknown or skipped profile {profile!r}'
            assert value is True or value is None, f'{profile}: value must be true or null (omit false)'
            assert reasons.get(profile, '').strip(), f'{profile}: reason missing'
            if value is None:
                assert alternatives.get(profile) in (True, False), f'{profile}: ambiguous needs alternatives true/false'
        rows.append({'q': q, 'labels': labels, 'reasons': reasons, 'alternatives': alternatives})
    except Exception as error:
        errors.append(f'line {n}: {error}')
if errors:
    print('NOTHING WRITTEN. Fix and resend the whole batch:\n' + '\n'.join(errors))
    sys.exit(1)
with open(out_path, 'a') as out:
    for row in rows:
        out.write(json.dumps(row, ensure_ascii=False) + '\n')
print(f'wrote {len(rows)}; {len(done) + len(rows)} of {len(in_queue)} labelled')
