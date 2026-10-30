# A neighbour graph decodes each vector once

A consumer can need the neighbours of each document in a date range, not of one document. Event detection clusters a window of 7 days again on each new publish day. It needs the 80 nearest neighbours of each report in the window.

With `nearest`, the consumer makes one call for each document. Each call reads and decodes every vector in the window of its document. Thus a range of n documents reads and decodes about n² BLOBs. Backlog #3137 measured one clustering of event detection at 2.9 s for 1,001 reports and at 28 s for 3,500 reports, with `nearest` for each report.

Thus `neighbourGraph({ from, to, k, withinDays })` gives the neighbours of each document published from `from` to `to`. The call reads and decodes each vector of the range and of its window one time. Then it calculates the neighbours of each document from the decoded vectors. Each entry is equal to the result of `nearest` for that document, with the same `k` and `withinDays`: the same window, no document as its own neighbour, and equal similarities in id order. `nearest` and `neighbourGraph` sort with one function, so the order is the same.

Other vector stores have this operation. A FAISS index searches many query vectors in one call (`index.search(queries, k)`). scikit-learn gives the k nearest neighbours of each sample in one call (`kneighbors_graph`).

The search stays exact. It compares each document with each document of its window (ADR 0001). Thus the number of similarities is the same as with `nearest`. Only the reads and the decodes are fewer.

## Considered Options

- **One `nearest` call for each document.** It needs no new method. It decodes each vector once for each document in its window.
- **A cache of decoded vectors in the collection.** It must know when an upsert changes a vector. It also keeps memory after the search.
- **A neighbour graph of a date range.** This option was selected.

## Consequences

- The graph decodes each vector of the range and of its window once.
- The cost of the similarities is the same as with `nearest`. It grows with the number of documents in the range times the number of documents in each window.
- The graph keeps all decoded vectors of the range and of its window in memory during the iteration.
- The call reads the vectors when the caller calls it. Then it calculates one entry each time the caller asks for the next entry. An upsert after the call does not change the entries.
