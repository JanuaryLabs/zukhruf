import { getAbstaskPrompt } from '../abstasks/abstask.ts';
import type { TaskMetadata } from '../abstasks/task-metadata.ts';
import {
  cosSim,
  dotScore,
  pairwiseCosSim,
  pairwiseDotScore,
} from '../similarity-functions.ts';
import type {
  BatchedInput,
  Embeddings,
  PromptType,
} from '../types/encoder-io.ts';
import type { ModelMeta } from './model-meta.ts';
import type { EncodeOptions, EncoderProtocol } from './models-protocols.ts';

// mteb/models/abs_encoder.py. validate_task_to_prompt_name is not ported: it
// checks task names against the task registry, which this package does not
// have.

// Where AbsEncoder.getInstruction looks for an instruction.
export type PromptSource =
  // promptsDict[task name] of the model.
  | 'custom_prompt'
  // The prompt of the task metadata.
  | 'default_task_prompt'
  // promptsDict[task type] of the model.
  | 'task_type_prompt'
  // promptsDict[prompt type] of the model.
  | 'encode_type_prompt';

export type InstructionTemplate =
  string | ((instruction: string, promptType: PromptType | null) => string);

// The base class of the wrappers of models. It chooses prompts and
// instructions, and computes similarities with the scoring function of the
// model's metadata.
export abstract class AbsEncoder implements EncoderProtocol {
  abstract readonly mtebModelMeta: ModelMeta;
  modelPrompts: Readonly<Record<string, string>> | null = null;
  instructionTemplate: InstructionTemplate | null = null;
  promptsDict: Readonly<Record<string, string>> | null = null;
  promptPriority: readonly PromptSource[] = [
    'custom_prompt',
    'task_type_prompt',
    'encode_type_prompt',
    'default_task_prompt',
  ];

  abstract encode(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): Promise<Embeddings>;

  getPromptName(
    taskMetadata: TaskMetadata,
    promptType: PromptType | null,
  ): string | null {
    return getPromptName(this.modelPrompts, taskMetadata, promptType);
  }

  getPrompt(
    taskMetadata: TaskMetadata,
    promptType: PromptType | null,
  ): string | null {
    return getPrompt(this.modelPrompts, taskMetadata, promptType);
  }

  // The instruction of the first source in promptPriority that has one, else
  // the prompt of the task's abstract task class.
  getInstruction(
    taskMetadata: TaskMetadata,
    promptType: PromptType | null,
  ): string {
    let prompt: TaskMetadata['prompt'] = taskMetadata.prompt;
    const keys: Record<
      Exclude<PromptSource, 'default_task_prompt'>,
      string | null
    > = {
      custom_prompt: taskMetadata.name,
      task_type_prompt: taskMetadata.type,
      encode_type_prompt: promptType,
    };
    for (const source of this.promptPriority) {
      if (source === 'default_task_prompt') {
        let taskPrompt = taskMetadata.prompt;
        if (isPromptMap(taskPrompt) && promptType !== null)
          taskPrompt = taskPrompt[promptType] ?? null;
        if (taskPrompt) break;
        continue;
      }
      const key = keys[source];
      if (this.promptsDict && key !== null && key in this.promptsDict) {
        prompt = this.promptsDict[key] ?? null;
        break;
      }
    }
    if (isPromptMap(prompt) && promptType !== null)
      return prompt[promptType] || '';
    if (typeof prompt === 'string' && prompt) return prompt;
    return getAbstaskPrompt(taskMetadata.name);
  }

  formatInstruction(
    instruction: string,
    promptType: PromptType | null = null,
  ): string {
    if (this.instructionTemplate === null)
      throw new Error(
        'Attempting to format an instruction without an instruction template.',
      );
    if (typeof this.instructionTemplate === 'string') {
      if (!this.instructionTemplate.includes('{instruction}'))
        throw new Error(
          "Instruction template must contain the string '{instruction}'.",
        );
      return this.instructionTemplate.replaceAll('{instruction}', instruction);
    }
    return this.instructionTemplate(instruction, promptType);
  }

  getTaskInstruction(
    taskMetadata: TaskMetadata,
    promptType: PromptType | null,
  ): string {
    const instruction = this.getInstruction(taskMetadata, promptType);
    // A function template is always called (MTEB issue #4683).
    if (
      this.instructionTemplate &&
      (typeof this.instructionTemplate === 'function' || instruction.length > 0)
    )
      return this.formatInstruction(instruction, promptType);
    return instruction;
  }

  similarity(embeddings1: Embeddings, embeddings2: Embeddings): Float32Array[] {
    switch (this.mtebModelMeta.similarityFnName ?? null) {
      case null:
      case 'cosine':
        return cosSim(embeddings1, embeddings2);
      case 'dot':
        return dotScore(embeddings1, embeddings2);
      case 'MaxSim':
        throw new Error('MaxSim similarity is not supported yet.');
      default:
        throw new Error('Similarity function not specified.');
    }
  }

  similarityPairwise(
    embeddings1: Embeddings,
    embeddings2: Embeddings,
  ): Float32Array {
    switch (this.mtebModelMeta.similarityFnName ?? null) {
      case null:
      case 'cosine':
        return pairwiseCosSim(embeddings1, embeddings2);
      case 'dot':
        return pairwiseDotScore(embeddings1, embeddings2);
      case 'MaxSim':
        throw new Error('MaxSim similarity is not supported yet.');
      default:
        throw new Error('Similarity function not specified.');
    }
  }
}

function isPromptMap(
  prompt: TaskMetadata['prompt'],
): prompt is Readonly<Partial<Record<PromptType, string>>> {
  return typeof prompt === 'object' && prompt !== null;
}

// The name of the prompt to use, in this order: "<task name>-<prompt type>",
// the task name, "<task type>-<prompt type>", the task type, the prompt type.
function getPromptName(
  modelPrompts: Readonly<Record<string, string>> | null,
  taskMetadata: TaskMetadata,
  promptType: PromptType | null,
): string | null {
  if (modelPrompts === null) return null;
  const { name, type } = taskMetadata;
  if (name && promptType && `${name}-${promptType}` in modelPrompts)
    return `${name}-${promptType}`;
  if (name && name in modelPrompts) return name;
  if (type && promptType && `${type}-${promptType}` in modelPrompts)
    return `${type}-${promptType}`;
  if (type && type in modelPrompts) return type;
  if (promptType && promptType in modelPrompts) return promptType;
  return null;
}

function getPrompt(
  modelPrompts: Readonly<Record<string, string>> | null,
  taskMetadata: TaskMetadata,
  promptType: PromptType | null,
): string | null {
  if (!modelPrompts || Object.keys(modelPrompts).length === 0) return null;
  const promptName = getPromptName(modelPrompts, taskMetadata, promptType);
  return promptName ? (modelPrompts[promptName] ?? null) : null;
}
