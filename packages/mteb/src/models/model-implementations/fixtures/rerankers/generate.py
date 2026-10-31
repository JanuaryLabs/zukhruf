# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the reranker fixture of rerankers.test.ts with Python MTEB:
# uv run packages/mteb/src/models/model-implementations/fixtures/rerankers/generate.py
#
# It writes expected.json: ModelMeta.to_dict of each cross-encoder that this
# package ports, with the training datasets sorted (a Python set has no
# fixed order), and the texts that the model of each loader scores for each
# pair when SearchCrossEncoderWrapper reranks the cross-encoder fixture task
# (../../../fixtures/cross-encoder/dataset). The weights do not load: each
# wrapper gets a recording model in place of FlagEmbedding, a
# sentence-transformers CrossEncoder or a causal LM. It also writes the
# errors of zip(strict=True) for lists of some lengths, the pairs or the
# error of Qwen3RerankerWrapper.predict with batch_size 2, and the error of
# each wrapper for 2 queries and 1 document.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import math
import os
import platform
import sys
import tempfile
from pathlib import Path

VERSIONS = {"mteb": "2.26.28", "numpy": "2.5.4", "torch": "2.14.1", "datasets": "5.1.0"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
DATASET = HERE.parent.parent.parent / "fixtures" / "cross-encoder" / "dataset"
BATCH_SIZE = 3

MODELS = [
    "mteb/baseline-no-reranking",
    "BAAI/bge-reranker-v2-m3",
    "jinaai/jina-reranker-v2-base-multilingual",
    "cross-encoder/ms-marco-TinyBERT-L2-v2",
    "cross-encoder/ms-marco-MiniLM-L2-v2",
    "cross-encoder/ms-marco-MiniLM-L4-v2",
    "cross-encoder/ms-marco-MiniLM-L6-v2",
    "cross-encoder/ms-marco-MiniLM-L12-v2",
    "Qwen/Qwen3-Reranker-0.6B",
    "Qwen/Qwen3-Reranker-4B",
    "Qwen/Qwen3-Reranker-8B",
]

with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.qwen3_reranker import Qwen3RerankerWrapper
    from mteb.models.model_implementations.rerankers_custom import BGEReranker, JinaReranker
    from mteb.models.openai_wrappers import OpenAIAPIRerankWrapper
    from mteb.models.search_wrappers import SearchCrossEncoderWrapper
    from mteb.models.sentence_transformer_wrapper import CrossEncoderWrapper

    metas = []
    for name in MODELS:
        meta = mteb.get_model_meta(name).to_dict()
        if meta["training_datasets"] is not None:
            meta["training_datasets"] = sorted(meta["training_datasets"])
        # JSON has no Infinity: a non-finite float is its repr, as the
        # predictions fixture writes it.
        metas.append(
            {
                key: repr(value).replace("inf", "Infinity") if isinstance(value, float) and not math.isfinite(value) else value
                for key, value in meta.items()
            }
        )

    class CrossEncoderFixture(AbsTaskRetrieval):
        metadata = TaskMetadata(
            name="CrossEncoderFixture",
            description="The cross-encoder fixture of @zukhruf/mteb.",
            dataset={"path": str(DATASET), "revision": "1"},
            type="Reranking",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="ndcg_at_10",
        )

    task = CrossEncoderFixture()
    task.load_data()
    split = task.dataset["default"]["test"]
    location = {
        "task_metadata": task.metadata,
        "hf_split": "test",
        "hf_subset": "default",
        "encode_kwargs": {"batch_size": BATCH_SIZE},
    }

    def scored(wrapper) -> None:
        search = SearchCrossEncoderWrapper(wrapper)
        search.index(split["corpus"], **location)
        search.search(split["queries"], top_k=10, top_ranked=split["top_ranked"], **location)

    class FlagReranker:
        def __init__(self, pairs):
            self.pairs = pairs

        def compute_score(self, pairs, normalize):
            assert normalize is True
            self.pairs.extend([list(pair) for pair in pairs])
            return [0.0] * len(pairs)

    class SentenceTransformersCrossEncoder:
        def __init__(self, pairs):
            self.pairs = pairs

        def predict(self, pairs, **kwargs):
            self.pairs.extend([list(pair) for pair in pairs])
            return np.zeros(len(pairs), dtype=np.float32)

    def bge():
        pairs = []
        model = BGEReranker.__new__(BGEReranker)
        model.mteb_model_meta = mteb.get_model_meta("BAAI/bge-reranker-v2-m3")
        model.model = FlagReranker(pairs)
        scored(model)
        return pairs

    def jina():
        pairs = []
        model = JinaReranker.__new__(JinaReranker)
        model.mteb_model_meta = mteb.get_model_meta("jinaai/jina-reranker-v2-base-multilingual")
        model.first_print = False
        model.model = SentenceTransformersCrossEncoder(pairs)
        scored(model)
        return pairs

    def cross_encoder():
        pairs = []
        model = CrossEncoderWrapper.__new__(CrossEncoderWrapper)
        model.mteb_model_meta = mteb.get_model_meta("cross-encoder/ms-marco-MiniLM-L6-v2")
        model.model = SentenceTransformersCrossEncoder(pairs)
        model.query_prefix = ""
        model.passage_prefix = ""
        model.fps = model.max_frames = model.num_frames = None
        model.target_sampling_rate = model.max_samples = None
        model.min_frames = 1
        scored(model)
        return pairs

    def qwen3():
        # The instruction, the query and the document of each pair, as
        # format_instruction gets them.
        pairs = []
        model = Qwen3RerankerWrapper.__new__(Qwen3RerankerWrapper)
        model.mteb_model_meta = mteb.get_model_meta("Qwen/Qwen3-Reranker-0.6B")
        model.format_instruction = lambda instruction, query, doc: pairs.append([instruction, query, doc]) or ""
        model.process_inputs = lambda formatted: len(formatted)
        model.compute_logits = lambda count: [0.0] * count
        scored(model)
        return pairs

    # The error of zip(*iterables, strict=True) for lists of these lengths,
    # or None.
    def zip_error(lengths):
        try:
            list(zip(*[range(length) for length in lengths], strict=True))
            return None
        except ValueError as error:
            return str(error)

    ZIP_LENGTHS = [[2, 2], [3, 2], [2, 3], [0, 1], [2, 2, 1], [2, 2, 3], [3, 2, 2], [2, 3, 1], [1, 2, 3], [2, 1, 3]]
    zip_errors = [[lengths, zip_error(lengths)] for lengths in ZIP_LENGTHS]

    # Qwen3RerankerWrapper.predict over batches of texts with batch_size 2:
    # the number of pairs it scores, or its error.
    class Loader(list):
        class dataset:
            features = {"text": None}

    def qwen3_predict(queries, passages):
        model = Qwen3RerankerWrapper.__new__(Qwen3RerankerWrapper)
        model.format_instruction = lambda instruction, query, doc: ""
        model.process_inputs = lambda formatted: len(formatted)
        model.compute_logits = lambda count: [0.0] * count
        try:
            scores = model.predict(
                Loader([{"text": [f"q{i}" for i in range(queries)]}]),
                Loader([{"text": [f"d{i}" for i in range(passages)]}]),
                task_metadata=task.metadata,
                hf_split="test",
                hf_subset="default",
                batch_size=2,
                show_progress_bar=False,
            )
            return {"pairs": len(scores)}
        except ValueError as error:
            return {"error": str(error)}

    # The error of each wrapper for 2 queries and 1 document.
    def length_error(model):
        queries = Loader([{"text": ["q0 i", "q1 i"], "query": ["q0", "q1"]}])
        documents = Loader([{"text": ["d0"]}])
        try:
            model.predict(queries, documents, task_metadata=task.metadata, hf_split="test", hf_subset="default")
        except ValueError as error:
            return str(error)
        raise AssertionError("no error")

    bge_model = BGEReranker.__new__(BGEReranker)
    bge_model.model = FlagReranker([])
    jina_model = JinaReranker.__new__(JinaReranker)
    jina_model.first_print = False
    jina_model.model = SentenceTransformersCrossEncoder([])
    cross_encoder_model = CrossEncoderWrapper.__new__(CrossEncoderWrapper)
    cross_encoder_model.model = SentenceTransformersCrossEncoder([])
    cross_encoder_model.query_prefix = cross_encoder_model.passage_prefix = ""
    cross_encoder_model.fps = cross_encoder_model.max_frames = cross_encoder_model.num_frames = None
    cross_encoder_model.target_sampling_rate = cross_encoder_model.max_samples = None
    cross_encoder_model.min_frames = 1
    rerank_model = OpenAIAPIRerankWrapper.__new__(OpenAIAPIRerankWrapper)
    rerank_model.fps = rerank_model.max_frames = rerank_model.num_frames = None
    rerank_model.target_sampling_rate = rerank_model.max_samples = None
    length_errors = {
        "BGEReranker": length_error(bge_model),
        "JinaReranker": length_error(jina_model),
        "CrossEncoderWrapper": length_error(cross_encoder_model),
        "OpenAIAPIRerankWrapper": length_error(rerank_model),
    }

    QWEN3_LENGTHS = [[3, 3], [3, 4], [3, 2], [4, 6], [4, 3]]
    qwen3_batches = [[lengths, qwen3_predict(*lengths)] for lengths in QWEN3_LENGTHS]

    texts = {
        "BGEReranker": bge(),
        "JinaReranker": jina(),
        "CrossEncoderWrapper": cross_encoder(),
        "Qwen3RerankerWrapper": qwen3(),
    }

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, "
    f"torch {VERSIONS['torch']}, datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "batch_size": BATCH_SIZE,
            "metas": metas,
            "texts": texts,
            "zip_errors": zip_errors,
            "qwen3_batches": qwen3_batches,
            "length_errors": length_errors,
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(metas)} metadata, {len(texts)} loaders", file=sys.stderr)
