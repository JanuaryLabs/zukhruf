# Builds the fresh stream's items.json (with queue numbers) and 4 blind annotator queues.
# Usage: python3 -I build-queue.py <relevance-profiles dir>
import json, random, sys
here = sys.argv[1]
articles = json.load(open(f'{here}/fresh-4/articles.json'))
items = [{'id': a['id'], 'publisher': a['publisher'], 'publishedAt': a['publishedAt'], 'title': a['title'],
          'excerpt': a.get('excerpt') or '', 'lead': a.get('lead') or a.get('excerpt') or '', 'body': a.get('body') or ''} for a in articles]
random.Random(31957).shuffle(items)
for q, item in enumerate(items, 1):
    item['q'] = q
json.dump(items, open(f'{here}/fresh-4/items.json', 'w'), ensure_ascii=False)
blind = lambda i: {'q': i['q'], 'title': i['title'], 'excerpt': i['excerpt'], 'lead': i['lead']}
for n in range(1, 5):
    json.dump([blind(i) for i in items[n - 1::4]], open(f'{here}/fresh-4/queue-{n}.json', 'w'), ensure_ascii=False, indent=0)
print(len(items), [len(items[n::4]) for n in range(4)])
