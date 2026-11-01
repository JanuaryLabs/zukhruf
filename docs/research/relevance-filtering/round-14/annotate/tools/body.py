# Prints the body of one article by its queue number.
# Usage: python3 -I body.py <items.json> <q> [max characters, default 4000]
import json, sys

items = {i['q']: i for i in json.load(open(sys.argv[1]))}
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 4000
print(items[int(sys.argv[2])]['body'][:limit])
