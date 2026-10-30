---
configs:
- config_name: default
  data_files:
  - split: test
    path: pairs/test.jsonl
  - split: train
    path:
    - pairs/train-b.jsonl
    - pairs/train-a.json
- config_name: extra
  data_dir: extra
---
# A dataset with configs
