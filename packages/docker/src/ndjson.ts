/**
 * The values of a stream of newline-delimited JSON. A chunk can end inside a
 * line, or inside a UTF-8 character: the line waits for the next chunk. An
 * empty line has no value.
 */
export async function* ndjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of chunks) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  rest += decoder.decode();
  if (rest.trim()) yield JSON.parse(rest);
}
