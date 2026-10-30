import type { EmbeddingModel } from 'ai';

import type { BatchedInput, PromptType } from '../types/encoder-io.ts';
import type { InstructionTemplate } from './abs-encoder.ts';
import { AiSdkTextEncoder } from './ai-sdk-text-encoder.ts';
import { ModelMeta } from './model-meta.ts';
import type { EncodeOptions } from './models-protocols.ts';

export type AiSdkEncoderOptions = {
  readonly model: Exclude<EmbeddingModel, string>;
  // The metadata of the model. Without it, the name is the model id and the
  // revision is unknown.
  readonly modelMeta?: ModelMeta;
  // The prompt to put before each text, by prompt name (see getPromptName).
  readonly promptDict?: Readonly<Record<string, string>> | null;
  // Put the instruction of the task before each text, formatted with
  // instructionTemplate.
  readonly useInstructions?: boolean;
  readonly instructionTemplate?: InstructionTemplate | null;
  // Put the instruction before documents too, not only before queries.
  readonly applyInstructionToDocuments?: boolean;
  // The retries of a failed call. MTEB makes 3 attempts.
  readonly maxRetries?: number;
};

// The text path of MTEB's OpenAIAPIEncodeWrapper (models/openai_wrappers.py),
// with an AI SDK embedding model in place of HTTP requests to an
// OpenAI-compatible server.
export class AiSdkEncoder extends AiSdkTextEncoder {
  readonly #useInstructions: boolean;
  readonly #applyInstructionToPassages: boolean;

  constructor(options: AiSdkEncoderOptions) {
    super({
      model: options.model,
      modelMeta:
        options.modelMeta ??
        ModelMeta.createEmpty({
          name: options.model.modelId,
          modalities: ['text'],
        }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    });
    this.promptsDict = options.promptDict ?? null;
    this.#useInstructions = options.useInstructions ?? false;
    this.instructionTemplate = options.instructionTemplate ?? null;
    this.#applyInstructionToPassages =
      options.applyInstructionToDocuments ?? true;
    if (this.#useInstructions && this.instructionTemplate === null)
      throw new Error(
        'To use instructions, an instruction_template must be provided. For example, `Instruction: {instruction}`',
      );
    if (
      typeof this.instructionTemplate === 'string' &&
      !this.instructionTemplate.includes('{instruction}')
    )
      throw new Error(
        "Instruction template must contain the string '{instruction}'.",
      );
  }

  protected texts(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): string[] {
    const prompt = this.#prompt(
      options.taskMetadata,
      options.promptType ?? null,
    );
    return inputs.flatMap((batch) => batch.text.map((text) => prompt + text));
  }

  #prompt(
    taskMetadata: EncodeOptions['taskMetadata'],
    promptType: PromptType | null,
  ): string {
    let prompt = '';
    if (this.#useInstructions && this.promptsDict !== null)
      prompt = this.getTaskInstruction(taskMetadata, promptType);
    else if (this.promptsDict !== null) {
      // As in MTEB, the prompt name comes from modelPrompts, which this
      // encoder does not set, so promptDict alone gives no prompt.
      const name = this.getPromptName(taskMetadata, promptType);
      if (name !== null) prompt = this.promptsDict[name] ?? '';
    }
    if (
      this.#useInstructions &&
      !this.#applyInstructionToPassages &&
      promptType === 'document'
    )
      return '';
    return prompt;
  }
}
