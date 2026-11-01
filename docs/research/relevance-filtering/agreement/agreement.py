# Agreement between the main pass and the second annotator on the 400-article sample,
# per profile: Cohen's kappa on relevant vs not (ambiguous counted as not, and as relevant),
# and how often one annotator's true is the other's null. Also Biology against the
# relevance-biology keys (anthropic-outlets exhaustive, pooled stream pool).
# Usage: python3 -I agreement.py <relevance-profiles dir>
import json, sys

here = sys.argv[1]
main = {r['q']: r['labels'] for r in json.load(open(f'{here}/labels.json'))}
ids = {r['q']: r['id'] for r in json.load(open(f'{here}/labels.json'))}
second = {}
for n in (1, 2):
    for line in open(f'{here}/agreement/labels-{n}.jsonl'):
        r = json.loads(line); second[r['q']] = r['labels']
profiles = [p['id'] for p in json.load(open(f'{here}/profiles.json'))['profiles']]

def kappa(a, b):
    n = len(a); po = sum(x == y for x, y in zip(a, b)) / n
    pa, pb = sum(a) / n, sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return (po - pe) / (1 - pe) if pe < 1 else float('nan')

out = {}
for p in profiles:
    m = [main[q].get(p, False) for q in sorted(second)]
    s = [second[q].get(p, False) for q in sorted(second)]
    strict = kappa([x is True for x in m], [x is True for x in s])
    loose = kappa([x is not False for x in m], [x is not False for x in s])
    out[p] = {'mainTrue': sum(x is True for x in m), 'secondTrue': sum(x is True for x in s),
              'bothTrue': sum(x is True and y is True for x, y in zip(m, s)),
              'trueVsNull': sum((x is True and y is None) or (x is None and y is True) for x, y in zip(m, s)),
              'trueVsFalse': sum((x is True and y is False) or (x is False and y is True) for x, y in zip(m, s)),
              'kappaStrict': round(strict, 3), 'kappaAmbiguousRelevant': round(loose, 3)}

bio = {}
old_ao = {r['id']: r['relevant'] for r in json.load(open(f'{here}/../relevance-biology/training/labels.json'))}
old_pool = {r['id']: r['relevant'] for r in json.load(open(f'{here}/../relevance-biology/pooled/labels.json'))}
for name, old in (('anthropic-outlets', old_ao), ('pooled', old_pool)):
    pairs = [(old[ids[q]], main[q].get('biology', False)) for q in main if ids[q] in old]
    bio[name] = {'n': len(pairs),
                 'table': {f'{a}->{b}': sum(1 for x, y in pairs if x is a and y is b) for a in (True, None, False) for b in (True, None, False)},
                 'kappaStrict': round(kappa([x is True for x, _ in pairs], [y is True for _, y in pairs]), 3)}
json.dump({'sample': len(second), 'profiles': out, 'biologyAgainstEarlierKeys': bio}, open(f'{here}/agreement/agreement.json', 'w'), indent=1)
print('sample', len(second))
for p, r in out.items(): print(f"{p:12} {r}")
for k, v in bio.items(): print(k, v)
