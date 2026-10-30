---
annotations_creators:
- human-annotated
language:
- eng
license: mit
multilinguality: monolingual
task_categories:
- text-classification
task_ids: []
tags:
- mteb
- text
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train-*
  - split: test
    path: data/test-*
dataset_info:
  features:
  - name: text
    dtype: string
  - name: label
    dtype: int64
  - name: label_text
    dtype: string
  download_size: 385744
  dataset_size: 1244216.3444239455
---
<!-- adapted from https://github.com/huggingface/huggingface_hub/blob/v0.30.2/src/huggingface_hub/templates/datasetcard_template.md -->

<div align="center" style="padding: 40px 20px; background-color: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05); max-width: 600px; margin: 0 auto;">
  <h1 style="font-size: 3.5rem; color: #1a1a1a; margin: 0 0 20px 0; letter-spacing: 2px; font-weight: 700;">Banking77Classification</h1>
  <div style="font-size: 1.5rem; color: #4a4a4a; margin-bottom: 5px; font-weight: 300;">An <a href="https://github.com/embeddings-benchmark/mteb" style="color: #2c5282; font-weight: 600; text-decoration: none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">MTEB</a> dataset</div>
  <div style="font-size: 0.9rem; color: #2c5282; margin-top: 10px;">Massive Text Embedding Benchmark</div>
</div>

Dataset composed of online banking queries annotated with their corresponding intents.

|               |                                             |
|---------------|---------------------------------------------|
| Task category | t2c                              |
| Domains       | Written                               |
| Reference     | https://arxiv.org/abs/2003.04807 |


## How to evaluate on this task

You can evaluate an embedding model on this dataset using the following code:

```python
import mteb

task = mteb.get_tasks(["Banking77Classification"])
evaluator = mteb.MTEB(task)

model = mteb.get_model(YOUR_MODEL)
evaluator.run(model)
```

<!-- Datasets want link to arxiv in readme to autolink dataset with paper -->
To learn more about how to run models on `mteb` task check out the [GitHub repitory](https://github.com/embeddings-benchmark/mteb). 

## Citation

If you use this dataset, please cite the dataset as well as [mteb](https://github.com/embeddings-benchmark/mteb), as this dataset likely includes additional processing as a part of the [MMTEB Contribution](https://github.com/embeddings-benchmark/mteb/tree/main/docs/mmteb).

```bibtex

@inproceedings{casanueva-etal-2020-efficient,
  address = {Online},
  author = {Casanueva, I{\~n}igo  and
Tem{\v{c}}inas, Tadas  and
Gerz, Daniela  and
Henderson, Matthew  and
Vuli{\'c}, Ivan},
  booktitle = {Proceedings of the 2nd Workshop on Natural Language Processing for Conversational AI},
  doi = {10.18653/v1/2020.nlp4convai-1.5},
  editor = {Wen, Tsung-Hsien  and
Celikyilmaz, Asli  and
Yu, Zhou  and
Papangelis, Alexandros  and
Eric, Mihail  and
Kumar, Anuj  and
Casanueva, I{\~n}igo  and
Shah, Rushin},
  month = jul,
  pages = {38--45},
  publisher = {Association for Computational Linguistics},
  title = {Efficient Intent Detection with Dual Sentence Encoders},
  url = {https://aclanthology.org/2020.nlp4convai-1.5},
  year = {2020},
}


@article{enevoldsen2025mmtebmassivemultilingualtext,
  title={MMTEB: Massive Multilingual Text Embedding Benchmark},
  author={Kenneth Enevoldsen and Isaac Chung and Imene Kerboua and Márton Kardos and Ashwin Mathur and David Stap and Jay Gala and Wissam Siblini and Dominik Krzemiński and Genta Indra Winata and Saba Sturua and Saiteja Utpala and Mathieu Ciancone and Marion Schaeffer and Gabriel Sequeira and Diganta Misra and Shreeya Dhakal and Jonathan Rystrøm and Roman Solomatin and Ömer Çağatan and Akash Kundu and Martin Bernstorff and Shitao Xiao and Akshita Sukhlecha and Bhavish Pahwa and Rafał Poświata and Kranthi Kiran GV and Shawon Ashraf and Daniel Auras and Björn Plüster and Jan Philipp Harries and Loïc Magne and Isabelle Mohr and Mariya Hendriksen and Dawei Zhu and Hippolyte Gisserot-Boukhlef and Tom Aarsen and Jan Kostkan and Konrad Wojtasik and Taemin Lee and Marek Šuppa and Crystina Zhang and Roberta Rocca and Mohammed Hamdy and Andrianos Michail and John Yang and Manuel Faysse and Aleksei Vatolin and Nandan Thakur and Manan Dey and Dipam Vasani and Pranjal Chitale and Simone Tedeschi and Nguyen Tai and Artem Snegirev and Michael Günther and Mengzhou Xia and Weijia Shi and Xing Han Lù and Jordan Clive and Gayatri Krishnakumar and Anna Maksimova and Silvan Wehrli and Maria Tikhonova and Henil Panchal and Aleksandr Abramov and Malte Ostendorff and Zheng Liu and Simon Clematide and Lester James Miranda and Alena Fenogenova and Guangyu Song and Ruqiya Bin Safi and Wen-Ding Li and Alessia Borghini and Federico Cassano and Hongjin Su and Jimmy Lin and Howard Yen and Lasse Hansen and Sara Hooker and Chenghao Xiao and Vaibhav Adlakha and Orion Weller and Siva Reddy and Niklas Muennighoff},
  publisher = {arXiv},
  journal={arXiv preprint arXiv:2502.13595},
  year={2025},
  url={https://arxiv.org/abs/2502.13595},
  doi = {10.48550/arXiv.2502.13595},
}

@article{muennighoff2022mteb,
  author = {Muennighoff, Niklas and Tazi, Nouamane and Magne, Lo{\"\i}c and Reimers, Nils},
  title = {MTEB: Massive Text Embedding Benchmark},
  publisher = {arXiv},
  journal={arXiv preprint arXiv:2210.07316},
  year = {2022}
  url = {https://arxiv.org/abs/2210.07316},
  doi = {10.48550/ARXIV.2210.07316},
}
```

# Dataset Statistics
<details>
  <summary> Dataset Statistics</summary>

The following code contains the descriptive statistics from the task. These can also be obtained using:

```python
import mteb

task = mteb.get_task("Banking77Classification")

desc_stats = task.metadata.descriptive_stats
```

```json
{
    "test": {
        "num_samples": 3080,
        "number_of_characters": 167036,
        "number_texts_intersect_with_train": 0,
        "min_text_length": 13,
        "average_text_length": 54.23246753246753,
        "max_text_length": 368,
        "unique_text": 3080,
        "unique_labels": 77,
        "labels": {
            "11": {
                "count": 40
            },
            "13": {
                "count": 40
            },
            "32": {
                "count": 40
            },
            "17": {
                "count": 40
            },
            "34": {
                "count": 40
            },
            "46": {
                "count": 40
            },
            "36": {
                "count": 40
            },
            "12": {
                "count": 40
            },
            "4": {
                "count": 40
            },
            "14": {
                "count": 40
            },
            "33": {
                "count": 40
            },
            "41": {
                "count": 40
            },
            "1": {
                "count": 40
            },
            "49": {
                "count": 40
            },
            "23": {
                "count": 40
            },
            "56": {
                "count": 40
            },
            "47": {
                "count": 40
            },
            "8": {
                "count": 40
            },
            "60": {
                "count": 40
            },
            "75": {
                "count": 40
            },
            "15": {
                "count": 40
            },
            "66": {
                "count": 40
            },
            "54": {
                "count": 40
            },
            "40": {
                "count": 40
            },
            "10": {
                "count": 40
            },
            "61": {
                "count": 40
            },
            "6": {
                "count": 40
            },
            "16": {
                "count": 40
            },
            "30": {
                "count": 40
            },
            "74": {
                "count": 40
            },
            "68": {
                "count": 40
            },
            "38": {
                "count": 40
            },
            "73": {
                "count": 40
            },
            "62": {
                "count": 40
            },
            "29": {
                "count": 40
            },
            "22": {
                "count": 40
            },
            "3": {
                "count": 40
            },
            "28": {
                "count": 40
            },
            "44": {
                "count": 40
            },
            "26": {
                "count": 40
            },
            "45": {
                "count": 40
            },
            "42": {
                "count": 40
            },
            "52": {
                "count": 40
            },
            "27": {
                "count": 40
            },
            "51": {
                "count": 40
            },
            "25": {
                "count": 40
            },
            "48": {
                "count": 40
            },
            "55": {
                "count": 40
            },
            "18": {
                "count": 40
            },
            "63": {
                "count": 40
            },
            "70": {
                "count": 40
            },
            "67": {
                "count": 40
            },
            "53": {
                "count": 40
            },
            "21": {
                "count": 40
            },
            "7": {
                "count": 40
            },
            "64": {
                "count": 40
            },
            "50": {
                "count": 40
            },
            "35": {
                "count": 40
            },
            "65": {
                "count": 40
            },
            "71": {
                "count": 40
            },
            "39": {
                "count": 40
            },
            "58": {
                "count": 40
            },
            "43": {
                "count": 40
            },
            "72": {
                "count": 40
            },
            "76": {
                "count": 40
            },
            "37": {
                "count": 40
            },
            "59": {
                "count": 40
            },
            "5": {
                "count": 40
            },
            "20": {
                "count": 40
            },
            "31": {
                "count": 40
            },
            "57": {
                "count": 40
            },
            "0": {
                "count": 40
            },
            "19": {
                "count": 40
            },
            "9": {
                "count": 40
            },
            "2": {
                "count": 40
            },
            "69": {
                "count": 40
            },
            "24": {
                "count": 40
            }
        }
    },
    "train": {
        "num_samples": 10003,
        "number_of_characters": 594916,
        "number_texts_intersect_with_train": null,
        "min_text_length": 13,
        "average_text_length": 59.47375787263821,
        "max_text_length": 433,
        "unique_text": 10003,
        "unique_labels": 77,
        "labels": {
            "11": {
                "count": 153
            },
            "13": {
                "count": 139
            },
            "32": {
                "count": 112
            },
            "17": {
                "count": 167
            },
            "34": {
                "count": 166
            },
            "46": {
                "count": 143
            },
            "36": {
                "count": 126
            },
            "12": {
                "count": 112
            },
            "4": {
                "count": 127
            },
            "14": {
                "count": 112
            },
            "33": {
                "count": 118
            },
            "41": {
                "count": 82
            },
            "1": {
                "count": 110
            },
            "49": {
                "count": 115
            },
            "23": {
                "count": 35
            },
            "56": {
                "count": 111
            },
            "47": {
                "count": 149
            },
            "8": {
                "count": 157
            },
            "60": {
                "count": 97
            },
            "75": {
                "count": 180
            },
            "15": {
                "count": 187
            },
            "66": {
                "count": 171
            },
            "54": {
                "count": 129
            },
            "40": {
                "count": 98
            },
            "10": {
                "count": 59
            },
            "61": {
                "count": 146
            },
            "6": {
                "count": 181
            },
            "16": {
                "count": 168
            },
            "30": {
                "count": 121
            },
            "74": {
                "count": 121
            },
            "68": {
                "count": 102
            },
            "38": {
                "count": 106
            },
            "73": {
                "count": 135
            },
            "62": {
                "count": 103
            },
            "29": {
                "count": 121
            },
            "22": {
                "count": 86
            },
            "3": {
                "count": 87
            },
            "28": {
                "count": 182
            },
            "44": {
                "count": 105
            },
            "26": {
                "count": 173
            },
            "45": {
                "count": 159
            },
            "42": {
                "count": 121
            },
            "52": {
                "count": 169
            },
            "27": {
                "count": 133
            },
            "51": {
                "count": 162
            },
            "25": {
                "count": 153
            },
            "48": {
                "count": 148
            },
            "55": {
                "count": 108
            },
            "18": {
                "count": 61
            },
            "63": {
                "count": 175
            },
            "70": {
                "count": 113
            },
            "67": {
                "count": 128
            },
            "53": {
                "count": 161
            },
            "21": {
                "count": 122
            },
            "7": {
                "count": 156
            },
            "64": {
                "count": 172
            },
            "50": {
                "count": 95
            },
            "35": {
                "count": 137
            },
            "65": {
                "count": 113
            },
            "71": {
                "count": 126
            },
            "39": {
                "count": 129
            },
            "58": {
                "count": 114
            },
            "43": {
                "count": 120
            },
            "72": {
                "count": 41
            },
            "76": {
                "count": 163
            },
            "37": {
                "count": 97
            },
            "59": {
                "count": 145
            },
            "5": {
                "count": 171
            },
            "20": {
                "count": 160
            },
            "31": {
                "count": 121
            },
            "57": {
                "count": 114
            },
            "0": {
                "count": 159
            },
            "19": {
                "count": 177
            },
            "9": {
                "count": 129
            },
            "2": {
                "count": 126
            },
            "69": {
                "count": 104
            },
            "24": {
                "count": 129
            }
        }
    }
}
```

</details>

---
*This dataset card was automatically generated using [MTEB](https://github.com/embeddings-benchmark/mteb)*