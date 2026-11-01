# Reports which queue items have no label yet.
# Usage: python3 -I check.py <queue.json> <labels.jsonl>
import json, os, sys

queue = [i['q'] for i in json.load(open(sys.argv[1]))]
done = {json.loads(l)['q'] for l in open(sys.argv[2]) if l.strip()} if os.path.exists(sys.argv[2]) else set()
missing = [q for q in queue if q not in done]
print(f'{len(queue) - len(missing)} of {len(queue)} labelled; missing positions:',
      [queue.index(q) + 1 for q in missing][:50])
