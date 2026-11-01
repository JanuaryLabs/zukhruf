# Merges the GPT annotators' label files into round-14/labels-gpt.json (one row per fresh-5 article, sorted by q).
# Usage: python3 -I merge.py <relevance-profiles dir>
import json, sys
here = sys.argv[1]
items = {i['q']: i for i in json.load(open(f'{here}/fresh-5/items.json'))}
rows = {}
for n in range(1, 5):
    for line in open(f'{here}/round-14/annotate/labels-gpt-{n}.jsonl'):
        if line.strip():
            r = json.loads(line)
            assert r['q'] not in rows, r['q']
            rows[r['q']] = {'q': r['q'], 'id': items[r['q']]['id'], 'annotator': f'gpt-{n}', **{k: r[k] for k in ('labels', 'reasons', 'alternatives')}}
assert sorted(rows) == sorted(items), 'coverage'
json.dump([rows[q] for q in sorted(rows)], open(f'{here}/round-14/labels-gpt.json', 'w'), ensure_ascii=False, indent=0)
print(len(rows), 'rows')
