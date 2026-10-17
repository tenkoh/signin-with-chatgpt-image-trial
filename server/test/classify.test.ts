import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/probe/classify.js';
import { imageProbeRequest, textProbeRequest } from '../src/probe/requests.js';
import type { ResponsesRun } from '../src/probe/types.js';

const base: ResponsesRun = {
  httpStatus: 200,
  events: [],
  outputText: '',
  images: [],
  durationMs: 10,
};

test('401 is auth_failed', () => {
  const r = classify('text', { ...base, httpStatus: 401 }, textProbeRequest('m'));
  assert.equal(r.verdict, 'auth_failed');
});

test('named unsupported code is unsupported', () => {
  const r = classify(
    'image',
    {
      ...base,
      httpStatus: 403,
      errorBody: { error: { code: 'subscription_sharing_route_not_supported' } },
    },
    imageProbeRequest('m'),
  );
  assert.equal(r.verdict, 'unsupported');
});

test('bare 403 without code is auth_failed not unsupported', () => {
  const r = classify(
    'image',
    { ...base, httpStatus: 403, errorBody: { error: { message: 'forbidden' } } },
    imageProbeRequest('m'),
  );
  assert.equal(r.verdict, 'auth_failed');
});

test('text output is pass', () => {
  const r = classify(
    'text',
    { ...base, outputText: 'pong', terminal: 'response.completed' },
    textProbeRequest('m'),
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.output, 'pong');
});

test('image bytes are pass', () => {
  const r = classify(
    'image',
    {
      ...base,
      images: [{ b64: 'aaa', mime: 'image/png' }],
      terminal: 'response.completed',
    },
    imageProbeRequest('m'),
  );
  assert.equal(r.verdict, 'pass');
  assert.ok(r.imageDataUrl?.startsWith('data:image/png;base64,'));
});

test('fixtures cover 401, route rejection, a failed event, and an image', () => {
  const load = (name: string): ResponsesRun =>
    JSON.parse(
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
    ) as ResponsesRun;
  assert.equal(
    classify('text', load('unauthorized.json'), textProbeRequest('gpt-5')).verdict,
    'auth_failed',
  );
  assert.equal(
    classify('image', load('route-not-supported.json'), imageProbeRequest('gpt-5')).evidence
      .errorCode,
    'route_not_supported',
  );
  const failed = classify('image', load('failed-event.json'), imageProbeRequest('gpt-5'));
  assert.equal(failed.verdict, 'unsupported');
  assert.equal(failed.evidence.errorCode, 'subscription_sharing_route_not_supported');
  const image = classify('image', load('success-image.json'), imageProbeRequest('gpt-5'));
  assert.equal(image.verdict, 'pass');
  assert.equal(image.imageDataUrl, 'data:image/png;base64,AAAA');
});
