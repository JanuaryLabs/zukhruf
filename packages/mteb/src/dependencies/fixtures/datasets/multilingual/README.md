---
configs:
- config_name: en
  data_files:
  - split: test
    path: en/test.parquet
  - split: train
    path: en/train.parquet
- config_name: de
  data_files:
  - split: test
    path: de/test-*.parquet
---
