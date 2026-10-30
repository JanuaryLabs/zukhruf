import type { TaskMetadata } from './abstasks/task-metadata.ts';
import type {
  BatchedInput,
  Conversation,
  ConversationTurn,
  CorpusRow,
  PromptType,
  QueryRow,
} from './types/encoder-io.ts';

// mteb/_create_dataloaders.py, for text. A torch DataLoader becomes the array
// of its batches; each batch holds each column of its rows as a list.

// A row as the encoder reads it: text is the text that the model gets.
type PreparedRow = Readonly<Record<string, unknown>> & {
  readonly text: string;
};

// A dataloader of plain texts.
function createDataloaderFromTexts(
  texts: readonly string[],
  options: { readonly batchSize?: number } = {},
): BatchedInput[] {
  return collate(
    texts.map((text) => ({ text })),
    options.batchSize ?? 32,
  );
}

// A document is its title and its text joined; body keeps the text. Python's
// Dataset.map keeps the other columns of the row.
function corpusToDict(row: CorpusRow): PreparedRow {
  const text =
    row.title !== undefined && row.title.length > 0
      ? `${row.title} ${row.text}`.trim()
      : row.text.trim();
  return { ...row, id: row.id, text, body: row.text };
}

// query keeps the text of each query; text gets its instruction after it.
export function combineQueriesWithInstructionText(
  rows: readonly (QueryRow & { readonly text: string })[],
): PreparedRow[] {
  const hasInstruction = rows.some((row) => 'instruction' in row);
  return rows.map(({ instruction, ...row }) => ({
    ...row,
    query: row.text,
    ...(hasInstruction ? { instruction: instruction ?? null } : {}),
    text: instruction === undefined ? row.text : `${row.text} ${instruction}`,
  }));
}

// A conversation becomes one query string: its turns as "role: content",
// joined with "; ", after the instruction.
function convertConvHistoryToQuery(
  row: QueryRow & { readonly text: Conversation | readonly string[] },
): PreparedRow {
  const items: readonly (string | ConversationTurn)[] = row.text;
  const [first] = items;
  let turns: Conversation;
  let joined: string;
  if (typeof first === 'string') {
    const messages = items.filter((turn) => typeof turn === 'string');
    turns = messages.map((content) => ({ role: 'user', content }));
    joined = messages.join('; ');
  } else if (typeof first === 'object') {
    turns = items.filter((turn) => typeof turn === 'object');
    if (turns.length !== items.length)
      throw new Error(
        "Turn is not a dictionary. When converting conversations lists of dictionary to string, each turn in the conversation must be a dictionary with 'role' and 'content' keys",
      );
    joined = turns.map((turn) => `${turn.role}: ${turn.content}`).join('; ');
  } else
    throw new Error(
      "Conversations must be a list consisting of strings or dictionaries with 'role' and 'content' keys",
    );
  return {
    ...row,
    query: joined,
    text:
      row.instruction === undefined ? joined : `${row.instruction} ${joined}`,
    conversation: turns,
  };
}

function hasTextColumn(row: CorpusRow | QueryRow): row is CorpusRow {
  return typeof row.text === 'string';
}

function prepareRows(
  rows: readonly (CorpusRow | QueryRow)[],
  promptType: PromptType | null,
): PreparedRow[] {
  const texts = rows.filter(hasTextColumn);
  if (promptType === 'document') return texts.map(corpusToDict);
  if (texts.length === rows.length)
    return combineQueriesWithInstructionText(texts);
  return rows.map((row) =>
    typeof row.text === 'string'
      ? { ...row, text: row.text }
      : convertConvHistoryToQuery({ ...row, text: row.text }),
  );
}

// _prepare_dataset: the transformations of the modalities of the task. Only
// text is supported; a task with another modality throws.
function prepareDataset(
  rows: readonly (CorpusRow | QueryRow)[],
  taskMetadata: TaskMetadata,
  promptType: PromptType | null,
): PreparedRow[] {
  const unsupported = taskMetadata
    .getModalities(promptType)
    .filter((modality) => modality !== 'text');
  if (unsupported.length > 0)
    throw new Error(
      `The ${unsupported.join(', ')} modality is not supported yet.`,
    );
  const prepared =
    promptType === null
      ? rows.filter(hasTextColumn).map((row) => ({ ...row }))
      : prepareRows(rows, promptType);
  // The columns of the modalities that this prompt type does not use.
  const dropped = new Set(['image', 'audio', 'video']);
  return prepared.map((row) => ({
    ...Object.fromEntries(
      Object.entries(row).filter(([key]) => !dropped.has(key)),
    ),
    text: row.text,
  }));
}

// _custom_collate_fn: each key of the first row becomes a list. A null value
// throws, except in the columns that hold lists of varying lengths.
function collate(
  rows: readonly PreparedRow[],
  batchSize: number,
): BatchedInput[] {
  const batches: BatchedInput[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const columns = Object.keys(batch[0] ?? {}).map((key) => {
      const values = batch.map((row) => row[key]);
      if (
        !['image', 'conversation', 'audio', 'video'].includes(key) &&
        values.some((value) => value === null || value === undefined)
      )
        throw new Error(`Found None in batch for key '${key}'`);
      return [key, values] as const;
    });
    batches.push({
      ...Object.fromEntries(columns),
      text: batch.map((row) => row.text),
    });
  }
  return batches;
}

// A dataloader of a dataset. Without a prompt type, a text task with an input
// column gives the texts of that column.
export function createDataloader(
  dataset: readonly (CorpusRow | QueryRow)[],
  options: {
    readonly taskMetadata: TaskMetadata;
    readonly promptType?: PromptType | null;
    readonly inputColumn?: keyof CorpusRow | keyof QueryRow | null;
    readonly batchSize?: number;
  },
): BatchedInput[] {
  const promptType = options.promptType ?? null;
  const batchSize = options.batchSize ?? 32;
  const inputColumn = options.inputColumn ?? null;
  const { modalities } = options.taskMetadata;
  if (
    promptType === null &&
    modalities.length === 1 &&
    modalities[0] === 'text' &&
    inputColumn !== null
  )
    return createDataloaderFromTexts(
      dataset.map((row) =>
        String(Object.entries(row).find(([key]) => key === inputColumn)?.[1]),
      ),
      { batchSize },
    );
  return collate(
    prepareDataset(dataset, options.taskMetadata, promptType),
    batchSize,
  );
}
