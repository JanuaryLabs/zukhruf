---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
  - config_name: instruction
    data_files:
      - split: test
        path: instruction.jsonl
  - config_name: top_ranked
    data_files:
      - split: test
        path: top_ranked.jsonl
---
