export interface SseMessage {
  event?: string;
  data: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const pulled = pullBlocks(buffer);
      buffer = pulled.rest;
      for (const message of pulled.messages) yield message;
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const message = parseBlock(buffer);
      if (message) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}

function pullBlocks(buffer: string): { rest: string; messages: SseMessage[] } {
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const messages: SseMessage[] = [];
  let rest = normalized;
  let splitAt = rest.indexOf('\n\n');
  while (splitAt !== -1) {
    const message = parseBlock(rest.slice(0, splitAt));
    if (message) messages.push(message);
    rest = rest.slice(splitAt + 2);
    splitAt = rest.indexOf('\n\n');
  }
  return { rest, messages };
}

function parseBlock(raw: string): SseMessage | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (event === undefined && data.length === 0) return undefined;
  if (event === undefined) return { data: data.join('\n') };
  return { event, data: data.join('\n') };
}
