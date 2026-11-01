# Prints queue items <from>..<to> (positions in the queue, 1-based, inclusive).
# Usage: python3 -I show.py <queue.json> <from> <to>
import json, sys

queue = json.load(open(sys.argv[1]))
start, end = int(sys.argv[2]), int(sys.argv[3])
print(f'queue has {len(queue)} items; showing positions {start}..{min(end, len(queue))}')
for item in queue[start - 1:end]:
    print(f"\n#{item['q']}\nT: {item['title']}")
    if item.get('excerpt') and item['excerpt'][:80] not in item['lead']:
        print(f"E: {item['excerpt']}")
    print(f"L: {item['lead']}")
