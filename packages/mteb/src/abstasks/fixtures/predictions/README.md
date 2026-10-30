---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
      - split: dev
        path: qrels/dev.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
---
