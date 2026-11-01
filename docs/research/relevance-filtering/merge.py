# Merges the main-pass label files into labels.json (one row per collection article,
# sorted by q, with id). Usage: python3 -I merge.py <relevance-profiles dir>
import json, sys

here = sys.argv[1]
items = {i['q']: i for i in json.load(open(f'{here}/collection/items.json'))}
rows = {}
for n in range(1, 9):
    for line in open(f'{here}/labels/labels-{n}.jsonl'):
        if line.strip():
            row = json.loads(line)
            assert row['q'] not in rows, row['q']
            rows[row['q']] = {'q': row['q'], 'id': items[row['q']]['id'], 'annotator': f'main-{n}', **{k: row[k] for k in ('labels', 'reasons', 'alternatives')}}
assert sorted(rows) == sorted(items), 'coverage'
json.dump([rows[q] for q in sorted(rows)], open(f'{here}/labels.json', 'w'), ensure_ascii=False, indent=0)
print(len(rows), 'rows')
