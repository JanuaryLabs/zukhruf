---
annotations_creators:
- expert-annotated
language:
- kor
license: cc-by-sa-4.0
multilinguality: monolingual
task_categories:
- text-classification
task_ids:
- multi-label-classification
- sentiment-analysis
- sentiment-scoring
- sentiment-classification
- hate-speech-detection
dataset_info:
  features:
  - name: text
    dtype: string
  - name: label
    sequence: int64
  download_size: 1259113
  dataset_size: 1901478
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train-*
  - split: validation
    path: data/validation-*
  - split: test
    path: data/test-*
tags:
- mteb
- text
---
<!-- adapted from https://github.com/huggingface/huggingface_hub/blob/v0.30.2/src/huggingface_hub/templates/datasetcard_template.md -->

<div align="center" style="padding: 40px 20px; background-color: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05); max-width: 600px; margin: 0 auto;">
  <h1 style="font-size: 3.5rem; color: #1a1a1a; margin: 0 0 20px 0; letter-spacing: 2px; font-weight: 700;">KorHateSpeechMLClassification</h1>
  <div style="font-size: 1.5rem; color: #4a4a4a; margin-bottom: 5px; font-weight: 300;">An <a href="https://github.com/embeddings-benchmark/mteb" style="color: #2c5282; font-weight: 600; text-decoration: none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">MTEB</a> dataset</div>
  <div style="font-size: 0.9rem; color: #2c5282; margin-top: 10px;">Massive Text Embedding Benchmark</div>
</div>


        The Korean Multi-label Hate Speech Dataset, K-MHaS, consists of 109,692 utterances from Korean online news comments,
        labelled with 8 fine-grained hate speech classes (labels: Politics, Origin, Physical, Age, Gender, Religion, Race, Profanity)
        or Not Hate Speech class. Each utterance provides from a single to four labels that can handles Korean language patterns effectively.
        For more details, please refer to the paper about K-MHaS, published at COLING 2022.
        This dataset is based on the Korean online news comments available on Kaggle and Github.
        The unlabeled raw data was collected between January 2018 and June 2020.
        The language producers are users who left the comments on the Korean online news platform between 2018 and 2020.
        

|               |                                             |
|---------------|---------------------------------------------|
| Task category | t2c                              |
| Domains       | Social, Written                               |
| Reference     | https://paperswithcode.com/dataset/korean-multi-label-hate-speech-dataset |


## How to evaluate on this task

You can evaluate an embedding model on this dataset using the following code:

```python
import mteb

task = mteb.get_tasks(["KorHateSpeechMLClassification"])
evaluator = mteb.MTEB(task)

model = mteb.get_model(YOUR_MODEL)
evaluator.run(model)
```

<!-- Datasets want link to arxiv in readme to autolink dataset with paper -->
To learn more about how to run models on `mteb` task check out the [GitHub repitory](https://github.com/embeddings-benchmark/mteb). 

## Citation

If you use this dataset, please cite the dataset as well as [mteb](https://github.com/embeddings-benchmark/mteb), as this dataset likely includes additional processing as a part of the [MMTEB Contribution](https://github.com/embeddings-benchmark/mteb/tree/main/docs/mmteb).

```bibtex

@inproceedings{lee-etal-2022-k,
  address = {Gyeongju, Republic of Korea},
  author = {Lee, Jean  and
Lim, Taejun  and
Lee, Heejun  and
Jo, Bogeun  and
Kim, Yangsok  and
Yoon, Heegeun  and
Han, Soyeon Caren},
  booktitle = {Proceedings of the 29th International Conference on Computational Linguistics},
  month = oct,
  pages = {3530--3538},
  publisher = {International Committee on Computational Linguistics},
  title = {K-{MH}a{S}: A Multi-label Hate Speech Detection Dataset in {K}orean Online News Comment},
  url = {https://aclanthology.org/2022.coling-1.311},
  year = {2022},
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

task = mteb.get_task("KorHateSpeechMLClassification")

desc_stats = task.metadata.descriptive_stats
```

```json
{
    "test": {
        "num_samples": 2037,
        "number_of_characters": 70625,
        "number_texts_intersect_with_train": 2,
        "min_text_length": 1,
        "average_text_length": 34.67108492881689,
        "max_text_length": 300,
        "unique_texts": 2037,
        "min_labels_per_text": 1,
        "average_label_per_text": 1.1467844869906725,
        "max_labels_per_text": 3,
        "unique_labels": 9,
        "labels": {
            "8": {
                "count": 1103
            },
            "0": {
                "count": 202
            },
            "5": {
                "count": 148
            },
            "1": {
                "count": 163
            },
            "2": {
                "count": 229
            },
            "4": {
                "count": 139
            },
            "7": {
                "count": 46
            },
            "3": {
                "count": 301
            },
            "6": {
                "count": 5
            }
        }
    },
    "train": {
        "num_samples": 8200,
        "number_of_characters": 276145,
        "number_texts_intersect_with_train": null,
        "min_text_length": 1,
        "average_text_length": 33.676219512195125,
        "max_text_length": 302,
        "unique_texts": 8192,
        "min_labels_per_text": 1,
        "average_label_per_text": 1.138170731707317,
        "max_labels_per_text": 4,
        "unique_labels": 9,
        "labels": {
            "8": {
                "count": 4451
            },
            "2": {
                "count": 886
            },
            "4": {
                "count": 553
            },
            "3": {
                "count": 1223
            },
            "1": {
                "count": 658
            },
            "5": {
                "count": 602
            },
            "0": {
                "count": 754
            },
            "7": {
                "count": 181
            },
            "6": {
                "count": 25
            }
        }
    }
}
```

</details>

---
*This dataset card was automatically generated using [MTEB](https://github.com/embeddings-benchmark/mteb)*