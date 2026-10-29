import type { Design } from './design.ts';

// Design 3142. Round #3142 chose it on the training sets with nested
// cross-validation of the CoNLL F0.5 (eval/rounds/3142/plan.json, candidate
// T). It is design 3152b with a clean body: the URLs go away before the
// sentence split, a segment that two reports of one publisher hold is in no
// lead and gives no number (src/templates.ts), and the weights and the
// threshold are fitted again with the training set labs-outlets
// (docs/adr/0006). `nx run event-grouping:fit -- 3142` fits it again.
export const design3142: Design = {
  name: '3142',
  planSha256:
    'aaaa1fceb54e32ebd4bcff5ffcdc86807850f336be54f5ba505ed236192633e1',
  embeddingModel: 'embeddinggemma-2',
  lead: {
    sentences: 2,
    minWords: 5,
    minLetterRatio: 0.6,
    maxUrlShare: 0.5,
    urlPattern: String.raw`(?:https?://|www\.)\S*`,
    clean: { templateReports: 2 },
  },
  // The EmbeddingGemma document prompt.
  vectorText: 'title: {title} | text: {title}\n{lead}',
  shortlistSize: 80,
  windowDays: 7,
  threshold: 0.45,
  pairScore: {
    intercept: -6.00930628601825,
    similarity: {
      weight: 2.421115134533651,
      mean: 0.6705475837316417,
      sd: 0.07141367676299294,
    },
    agreeingNumbers: {
      weight: 1.1047124180570962,
      mean: 0.5220741623456666,
      sd: 0.6288076141901435,
    },
    disagreeingNumbers: {
      weight: -0.9948611611230535,
      mean: 1.479057356408442,
      sd: 0.8191251607818617,
    },
    samePublisher: {
      weight: -0.5503556625404615,
      mean: 0.11965654894994232,
      sd: 0.3245594849073258,
    },
  },
};
