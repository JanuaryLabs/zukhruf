// mteb/models/model_implementations/bge_models.py: bge_m3_training_data only,
// for the metadata of BAAI/bge-reranker-v2-m3. The BGE encoders are not
// ported.

// The MTEB names of the datasets that BGE-M3 was trained on
// (https://arxiv.org/abs/2402.03216). Some are translations that the model
// was not trained on.
export const bgeM3TrainingData: ReadonlySet<string> = new Set([
  'MIRACLRetrieval',
  'MIRACLRetrievalHardNegatives',
  'MIRACLReranking',
  'LeCaRDv2',
  'CMedQAv1-reranking',
  'CMedQAv2-reranking',
  'MrTidyRetrieval',
  'T2Reranking',
  'MSMARCO',
  'MSMARCOHardNegatives',
  'NanoMSMARCORetrieval',
  'MSMARCO-PL',
  'mMARCO-NL',
  'NQ',
  'NQ-NL',
  'NQHardNegatives',
  'NanoNQRetrieval',
  'NQ-PL',
  'HotpotQA',
  'HotpotQA-PL',
  'HotpotQA-NL',
  'HotpotQAHardNegatives',
  'T2Retrieval',
  'DuRetrieval',
  'MMarcoReranking',
  'CodeSearchNet',
]);
