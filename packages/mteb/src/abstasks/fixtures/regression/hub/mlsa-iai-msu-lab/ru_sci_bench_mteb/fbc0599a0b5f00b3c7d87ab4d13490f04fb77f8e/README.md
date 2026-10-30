---
dataset_info:
- config_name: cited_count_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: value
    dtype: int64
- config_name: cited_count_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: value
    dtype: int64
- config_name: corerisc_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: int64
- config_name: corerisc_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: int64
- config_name: grnti_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: grnti_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: oecd_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: oecd_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: pub_type_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: pub_type_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: label
    dtype: string
- config_name: yearpubl_en
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: value
    dtype: int64
- config_name: yearpubl_ru
  features:
  - name: paper_id
    dtype: int64
  - name: text
    dtype: string
  - name: value
    dtype: int64
configs:
- config_name: cited_count_en
  data_files:
  - split: train
    path: cited_count_en/train-*
  - split: test
    path: cited_count_en/test-*
- config_name: cited_count_ru
  data_files:
  - split: train
    path: cited_count_ru/train-*
  - split: test
    path: cited_count_ru/test-*
- config_name: corerisc_en
  data_files:
  - split: train
    path: corerisc_en/train-*
  - split: test
    path: corerisc_en/test-*
- config_name: corerisc_ru
  data_files:
  - split: train
    path: corerisc_ru/train-*
  - split: test
    path: corerisc_ru/test-*
- config_name: grnti_en
  data_files:
  - split: train
    path: grnti_en/train-*
  - split: test
    path: grnti_en/test-*
- config_name: grnti_ru
  data_files:
  - split: train
    path: grnti_ru/train-*
  - split: test
    path: grnti_ru/test-*
- config_name: oecd_en
  data_files:
  - split: train
    path: oecd_en/train-*
  - split: test
    path: oecd_en/test-*
- config_name: oecd_ru
  data_files:
  - split: train
    path: oecd_ru/train-*
  - split: test
    path: oecd_ru/test-*
- config_name: pub_type_en
  data_files:
  - split: train
    path: pub_type_en/train-*
  - split: test
    path: pub_type_en/test-*
- config_name: pub_type_ru
  data_files:
  - split: train
    path: pub_type_ru/train-*
  - split: test
    path: pub_type_ru/test-*
- config_name: yearpubl_en
  data_files:
  - split: train
    path: yearpubl_en/train-*
  - split: test
    path: yearpubl_en/test-*
- config_name: yearpubl_ru
  data_files:
  - split: train
    path: yearpubl_ru/train-*
  - split: test
    path: yearpubl_ru/test-*
---
