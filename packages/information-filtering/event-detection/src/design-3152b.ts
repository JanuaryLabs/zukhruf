import type { Design } from './design.ts';

// Design 3152b. Round #3152 chose the pair score, and its second selection
// (3152b) chose the threshold with the CoNLL F0.5 objective. 3152b froze them
// in its plan.json before it scored its exam set. The lead rule, the vector
// text, the shortlist and the window are those of round #3130
// (docs/adr/0001). `nx run event-detection:fit -- 3152b` fits this design
// again from the training sets (docs/adr/0005).
export const design3152b: Design = {
  name: '3152b',
  planSha256:
    'dc26dbd8c26341ca4245552d017161307f30b79aef4bc5ba3a171a72a534c479',
  embeddingModel: 'embeddinggemma-2',
  lead: {
    sentences: 2,
    minWords: 5,
    minLetterRatio: 0.6,
    maxUrlShare: 0.5,
    urlPattern: String.raw`(?:https?://|www\.)\S*`,
  },
  // The EmbeddingGemma document prompt.
  vectorText: 'title: {title} | text: {title}\n{lead}',
  shortlistSize: 80,
  windowDays: 7,
  threshold: 0.45,
  pairScore: {
    intercept: -5.577353541021158,
    similarity: {
      weight: 2.463189037261233,
      mean: 0.6697853674594684,
      sd: 0.0768108602613357,
    },
    agreeingNumbers: {
      weight: 1.2184550356722605,
      mean: 0.7080452669318389,
      sd: 0.7146516956780061,
    },
    disagreeingNumbers: {
      weight: -0.8987930339729852,
      mean: 1.6871729914951807,
      sd: 0.8093686065424462,
    },
    samePublisher: {
      weight: -0.6864362601504641,
      mean: 0.12460342227076507,
      sd: 0.3302686927775403,
    },
  },
};
