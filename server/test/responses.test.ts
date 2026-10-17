import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callResponses } from '../src/probe/responses.js';
import { imageProbeRequest, textProbeRequest } from '../src/probe/requests.js';
import { isRecord } from '../src/record.js';

const cfg = { responsesUrl: 'https://api.openai.com/v1/responses' };
const imageB64 = 'A'.repeat(80);

function sseFetch(body: string, status = 200): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    assert.equal(url, cfg.responsesUrl);
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer access-token');
    assert.equal(headers.get('accept'), 'text/event-stream');
    const sent = JSON.parse(String(init?.body)) as { store: boolean; stream: boolean };
    assert.equal(sent.store, false);
    assert.equal(sent.stream, true);
    return new Response(body, {
      status,
      headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' },
    });
  };
}

describe('callResponses', () => {
  it('reads text deltas from the SSE stream', async () => {
    const body = readFileSync(new URL('./fixtures/text-pass.sse', import.meta.url), 'utf8');
    const run = await callResponses('access-token', textProbeRequest('gpt-5'), cfg, sseFetch(body));
    assert.equal(run.httpStatus, 200);
    assert.equal(run.outputText, 'pong');
    assert.equal(run.terminal, 'response.completed');
    assert.deepEqual(
      run.events.map((event) => event.type),
      ['response.output_text.delta', 'response.output_text.delta', 'response.completed'],
    );
  });

  it('keeps the image bytes and truncates them in the event trace', async () => {
    const raw = readFileSync(new URL('./fixtures/image-pass.sse', import.meta.url), 'utf8');
    const body = raw.replaceAll('A'.repeat(80), imageB64);
    const run = await callResponses(
      'access-token',
      imageProbeRequest('gpt-5'),
      cfg,
      sseFetch(body),
    );
    assert.equal(run.images.length, 1);
    assert.equal(run.images[0]?.b64, imageB64);
    assert.equal(run.images[0]?.mime, 'image/png');
    const done = run.events.find((event) => event.type === 'response.output_item.done');
    assert.ok(done && isRecord(done.data) && isRecord(done.data.item));
    const result = done.data.item.result;
    assert.equal(typeof result, 'string');
    assert.equal(String(result).startsWith(imageB64), false);
    assert.match(String(result), /\.\.\.\(\d+\)$/);
  });

  it('returns the JSON error body on a non-2xx response', async () => {
    const fetchImpl = sseFetch(
      JSON.stringify({ error: { code: 'route_not_supported', message: 'nope' } }),
      403,
    );
    const run = await callResponses('access-token', imageProbeRequest('gpt-5'), cfg, fetchImpl);
    assert.equal(run.httpStatus, 403);
    assert.deepEqual(run.events, []);
    assert.deepEqual(run.errorBody, { error: { code: 'route_not_supported', message: 'nope' } });
  });
});
