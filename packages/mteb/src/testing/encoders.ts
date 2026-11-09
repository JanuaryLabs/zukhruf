import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';

type Embed = (text: string) => number[];

export function embeddingEncoder(name: string, embed: Embed): AiSdkEncoder {
  return new AiSdkEncoder({
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: name,
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed({ values }) {
        return {
          embeddings: values.map(embed),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    },
    modelMeta: ModelMeta.createEmpty({ name: `test/${name}`, revision: '1' }),
  });
}

/** An encoder whose calls the test reads back. */
export function recordingEncoder(name: string, embed: Embed) {
  const calls: { readonly hf_split: string; readonly texts: string[] }[] = [];
  const encoder = embeddingEncoder(name, embed);
  const encode = encoder.encode.bind(encoder);
  encoder.encode = async (inputs, options) => {
    calls.push({
      hf_split: options.hfSplit,
      texts: inputs.flatMap((batch) => batch.text),
    });
    return encode(inputs, options);
  };
  return { encoder, calls };
}

/** The vector encoder of generate.py: each text is numbers with spaces between them. */
export const embedVector: Embed = (text) => text.split(' ').map(Number);

/**
 * The code point count encoder of generate.py: the value at k is the number of
 * code points c of the text with c % dimension == k.
 */
export function embedCodePointCounts(dimension: number): Embed {
  return (text) => {
    const vector = new Array<number>(dimension).fill(0);
    for (const character of text) {
      const k = (character.codePointAt(0) ?? 0) % dimension;
      vector[k] = (vector[k] ?? 0) + 1;
    }
    return vector;
  };
}
