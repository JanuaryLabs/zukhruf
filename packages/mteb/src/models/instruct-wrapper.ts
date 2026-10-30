import type { EmbeddingModel } from 'ai';

import type { BatchedInput } from '../types/encoder-io.ts';
import type { InstructionTemplate, PromptSource } from './abs-encoder.ts';
import { AiSdkTextEncoder } from './ai-sdk-text-encoder.ts';
import type { ModelMeta } from './model-meta.ts';
import type { EncodeOptions } from './models-protocols.ts';

// The text path of InstructSentenceTransformerModel (models/instruct_wrapper.py)
// with an AI SDK embedding model in place of a SentenceTransformer: the
// instruction of the task, formatted with the template of the model, goes
// right before each text, as SentenceTransformer.encode(prompt=...) puts it.
export class InstructAiSdkEncoder extends AiSdkTextEncoder {
  readonly applyInstructionToPassages: boolean;

  constructor(options: {
    readonly model: Exclude<EmbeddingModel, string>;
    readonly modelMeta: ModelMeta;
    // A string with "{instruction}", or a function of the instruction and
    // the prompt type. Without a template, the instruction is used as it is.
    readonly instructionTemplate?: InstructionTemplate | null;
    // Put the instruction before documents too, not only before queries.
    readonly applyInstructionToPassages?: boolean;
    // Instructions by task name, task type or prompt type, over the prompt
    // of the task metadata.
    readonly promptsDict?: Readonly<Record<string, string>> | null;
    readonly promptPriority?: readonly PromptSource[];
    readonly maxRetries?: number;
  }) {
    super({
      model: options.model,
      modelMeta: options.modelMeta,
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    });
    const template = options.instructionTemplate ?? null;
    if (typeof template === 'string' && !template.includes('{instruction}'))
      throw new Error(
        "Instruction template must contain the string '{instruction}'.",
      );
    if (options.promptPriority !== undefined)
      this.promptPriority = options.promptPriority;
    this.instructionTemplate = template;
    this.applyInstructionToPassages =
      options.applyInstructionToPassages ?? true;
    this.promptsDict = options.promptsDict ?? null;
  }

  protected texts(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): string[] {
    const promptType = options.promptType ?? null;
    const instruction =
      !this.applyInstructionToPassages && promptType === 'document'
        ? ''
        : this.getTaskInstruction(options.taskMetadata, promptType);
    return inputs.flatMap((batch) =>
      batch.text.map((text) => instruction + text),
    );
  }
}
