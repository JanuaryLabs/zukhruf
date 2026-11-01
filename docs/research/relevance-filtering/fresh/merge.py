# Merges the fresh label files into fresh/labels.json (one row per fresh article, sorted by q).
import json, sys
here = sys.argv[1]
items = {i['q']: i for i in json.load(open(f'{here}/fresh/items.json'))}
rows = {}
for n in range(1, 5):
    for line in open(f'{here}/fresh/labels-{n}.jsonl'):
        if line.strip():
            r = json.loads(line)
            assert r['q'] not in rows, r['q']
            rows[r['q']] = {'q': r['q'], 'id': items[r['q']]['id'], 'annotator': f'fresh-{n}', **{k: r[k] for k in ('labels', 'reasons', 'alternatives')}}
assert sorted(rows) == sorted(items), 'coverage'
json.dump([rows[q] for q in sorted(rows)], open(f'{here}/fresh/labels.json', 'w'), ensure_ascii=False, indent=0)
print(len(rows), 'rows')
