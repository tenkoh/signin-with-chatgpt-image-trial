import type { Config } from '../config.js';
import { isRecord } from '../record.js';
import type { ResponsesBody } from './requests.js';
import { parseSse, type SseMessage } from './sse.js';
import type { ResponsesRun, SseEventSummary } from './types.js';

interface Acc {
  events: SseEventSummary[];
  outputText: string;
  images: { b64: string; mime: string }[];
  terminal?: ResponsesRun['terminal'];
}

export async function callResponses(
  accessToken: string,
  body: ResponsesBody,
  cfg: Pick<Config, 'responsesUrl'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ResponsesRun> {
  const started = Date.now();
  const acc: Acc = { events: [], outputText: '', images: [] };
  let httpStatus = 0;
  try {
    const res = await fetchImpl(cfg.responsesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    httpStatus = res.status;
    if (!res.ok) {
      return {
        httpStatus,
        errorBody: await readErrorBody(res),
        events: [],
        outputText: '',
        images: [],
        durationMs: Date.now() - started,
      };
    }
    if (res.body) {
      for await (const message of parseSse(res.body)) noteSse(acc, message);
    }
    return finish(httpStatus, acc, started);
  } catch (err) {
    const timeout = isTimeout(err);
    return {
      httpStatus: timeout ? httpStatus : 0,
      errorBody: { error: { message: timeout ? 'stream timeout' : 'network error' } },
      events: acc.events,
      outputText: acc.outputText,
      images: acc.images,
      durationMs: Date.now() - started,
    };
  }
}

function finish(httpStatus: number, acc: Acc, started: number): ResponsesRun {
  const run: ResponsesRun = {
    httpStatus,
    events: acc.events,
    outputText: acc.outputText,
    images: acc.images,
    durationMs: Date.now() - started,
  };
  if (acc.terminal) run.terminal = acc.terminal;
  return run;
}

function noteSse(acc: Acc, message: SseMessage): void {
  if (message.data === '[DONE]') return;
  const parsed = parseData(message.data);
  const type =
    message.event ??
    (isRecord(parsed) && typeof parsed.type === 'string' ? parsed.type : 'message');
  acc.events.push({ type, data: summarize(parsed) });
  if (!isRecord(parsed)) {
    if (type === 'error') acc.terminal = 'error';
    return;
  }
  if (type === 'response.output_text.delta' && typeof parsed.delta === 'string')
    acc.outputText += parsed.delta;
  if (
    type === 'response.output_text.done' &&
    typeof parsed.text === 'string' &&
    acc.outputText.length === 0
  ) {
    acc.outputText = parsed.text;
  }
  if (type === 'response.output_item.done') collectImage(acc, parsed.item);
  if (type === 'response.completed') {
    acc.terminal = 'response.completed';
    const response = parsed.response;
    if (isRecord(response) && Array.isArray(response.output)) {
      for (const item of response.output) collectImage(acc, item);
      if (acc.outputText.length === 0) acc.outputText = assistantText(response.output);
    }
  }
  if (type === 'response.failed') acc.terminal = 'response.failed';
  if (type === 'response.incomplete') acc.terminal = 'response.incomplete';
  if (type === 'error') acc.terminal = 'error';
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function collectImage(acc: Acc, item: unknown): void {
  if (!isRecord(item) || item.type !== 'image_generation_call') return;
  if (typeof item.result !== 'string' || item.result.length === 0) return;
  let mime = 'image/png';
  if (typeof item.output_format === 'string' && item.output_format.length > 0) {
    mime = item.output_format.includes('/') ? item.output_format : `image/${item.output_format}`;
  }
  let b64 = item.result;
  const dataUrl = /^data:([^;]+);base64,([\s\S]+)$/.exec(item.result);
  if (dataUrl?.[1] && dataUrl[2]) {
    mime = dataUrl[1];
    b64 = dataUrl[2];
  }
  if (acc.images.some((image) => image.b64 === b64)) return;
  acc.images.push({ b64, mime });
}

function assistantText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string')
        parts.push(part.text);
    }
  }
  return parts.join('');
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 2000) } };
  }
}

function isTimeout(err: unknown): boolean {
  return isRecord(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function summarize(value: unknown): unknown {
  return walk(value, '');
}

function walk(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    if (value.length > 64 && (b64Key(key) || isMostlyB64(value))) {
      return `${value.slice(0, 64)}...(${value.length})`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = walk(child, childKey);
    return out;
  }
  return value;
}

function b64Key(key: string): boolean {
  return /b64|result|image/i.test(key);
}

function isMostlyB64(value: string): boolean {
  return value.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}
