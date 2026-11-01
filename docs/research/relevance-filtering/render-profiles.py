# Renders profiles.json into profiles.md, the annotators' rule, and checks the
# biology statement against relevance-biology/rule.md word for word.
import json, re, sys

here = sys.argv[1]
spec = json.load(open(f'{here}/profiles.json'))
rule = open(f'{here}/../relevance-biology/rule.md').read()
words = lambda s: re.sub(r'[*`]', '', ' '.join(s.split()))
bio = next(p for p in spec['profiles'] if p['id'] == 'biology')
for part in [bio['relevant'], bio['ambiguous'], *bio['notRelevant']]:
    assert words(part)[:-1] in words(rule), part[:60]

out = ['# Labelling rule: news profiles', '',
       'TREC-style topic statements. Written and hashed before the first label.', '',
       '## Rules for every profile', '']
out += [f'- {c}' for c in spec['common']]
out += ['', 'Label values: `true` (relevant), `null` (ambiguous: give the alternative and the reason).',
        'Every profile you do not list for an article is not relevant (`false`).', '']
for p in spec['profiles']:
    out += [f'## `{p["id"]}`: {p["title"]}', '', f'Description: {p["description"]}', '',
            f'Relevant: {p["relevant"]}', '', 'Not relevant when:', '']
    out += [f'{i}. {n}' for i, n in enumerate(p['notRelevant'], 1)]
    if 'mainSubject' in p:
        out += ['', f'Main-subject test: {p["mainSubject"]}']
    out += ['', f'Ambiguous, typical cases: {p["ambiguous"]}', '']
out += ['## Procedure', '',
        '- One annotator per article: Claude (Opus 5.5). A random 400 articles get a second, independent annotator.',
        '- Label from the title and the lead; read the body when the lead is unclear.',
        '- Read every article in your queue. Do not scan or filter by keywords.',
        '- Blind: no model output, embeddings, scores, keyword lists or earlier labels are used.']
open(f'{here}/profiles.md', 'w').write('\n'.join(out) + '\n')
for name, b in json.load(open(f'{here}/keywords.json'))['baselines'].items():
    re.compile(b['narrow'], re.I); re.compile(b['broad'], re.I)
assert set(json.load(open(f'{here}/keywords.json'))['baselines']) == {p['id'] for p in spec['profiles']}
print(len(spec['profiles']), 'profiles rendered; biology matches rule.md; keywords compile')
