---
dataset_info:
  features:
  - name: score
    dtype: float32
  - name: text
    dtype: string
  - name: label
    dtype:
      class_label:
        names:
          '0': neg
          '1': pos
  - name: values
    sequence: float32
  - name: count
    dtype: int32
  - name: missing
    dtype: string
---
