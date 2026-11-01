# Embeds each profile's description with the EmbeddingGemma query prompt on the
# :8098 server after the probe check, and checks Biology against round 1.
# Usage: python3 -I embed-descriptions.py <relevance-profiles dir>
import json, sys, urllib.request
import numpy as np

here = sys.argv[1]
def embed(texts):
    request = urllib.request.Request('http://127.0.0.1:8098/v1/embeddings',
        data=json.dumps({'model': 'embeddinggemma-2', 'input': texts}).encode(), headers={'Content-Type': 'application/json'})
    data = json.load(urllib.request.urlopen(request))['data']
    vectors = np.array([d['embedding'] for d in sorted(data, key=lambda d: d['index'])], dtype=np.float64)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)

probe = json.load(open('/Users/ezzabuzaid/Desktop/experiments/mutex/packages/event-grouping/eval/embedding-probe.json'))
reference = np.array(probe['vector']); reference /= np.linalg.norm(reference)
probe_cosine = float(embed([probe['text']])[0] @ reference)
assert probe_cosine >= 0.9999, probe_cosine

profiles = json.load(open(f'{here}/profiles.json'))['profiles']
texts = [f"task: search result | query: {p['description']}" for p in profiles]
vectors = embed(texts)
round1 = {r['id']: r for r in json.load(open(f'{here}/../relevance-biology/round-1/vectors.json'))['rows']}
old = np.array(round1['description:query']['vector']); old /= np.linalg.norm(old)
biology_cosine = float(vectors[[p['id'] for p in profiles].index('biology')] @ old)
assert biology_cosine >= 0.9999, biology_cosine
json.dump({'model': 'embeddinggemma-2-Q8_0 (llama.cpp b11836, :8098)', 'probeCosine': probe_cosine, 'biologyRound1Cosine': biology_cosine,
           'rows': [{'id': p['id'], 'text': t, 'vector': v.tolist()} for p, t, v in zip(profiles, texts, vectors)]},
          open(f'{here}/round-2/descriptions.json', 'w'))
print('probe', probe_cosine, 'biology vs round 1', biology_cosine, 'rows', len(profiles))
