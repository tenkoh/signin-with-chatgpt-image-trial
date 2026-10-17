import type { ProbeKind, ProbeReport, Verdict } from '../public-types.js';
import { isRecord } from '../record.js';
import type { ResponsesBody } from './requests.js';
import { summarize } from './responses.js';
import type { ResponsesRun } from './types.js';

export function classify(kind: ProbeKind, run: ResponsesRun, req: ResponsesBody): ProbeReport {
  const errorCode = findErrorCode(run);
  if (run.httpStatus === 401)
    return report(kind, run, req, 'auth_failed', 'The API returned 401.', errorCode);
  if (routeRejected(errorCode) || clientRejectedTool(run)) {
    return report(kind, run, req, 'unsupported', unsupportedReason(errorCode), errorCode);
  }
  if (run.httpStatus === 403) {
    return report(
      kind,
      run,
      req,
      'auth_failed',
      'The API returned 403 without a route-support error.',
      errorCode,
    );
  }
  if (isStreamTimeout(run)) {
    return report(kind, run, req, 'error', 'The response stream timed out.', errorCode);
  }
  if (run.httpStatus < 200 || run.httpStatus >= 300) {
    const reason =
      run.httpStatus === 0
        ? 'The request to the Responses API failed before a response.'
        : `The API returned HTTP ${run.httpStatus}.`;
    return report(kind, run, req, 'error', reason, errorCode);
  }
  if (run.terminal === 'response.failed' || run.terminal === 'error') {
    if (routeRejected(errorCode) || namesImageTool(run)) {
      return report(kind, run, req, 'unsupported', unsupportedReason(errorCode), errorCode);
    }
    return report(
      kind,
      run,
      req,
      'error',
      'The response failed before producing output.',
      errorCode,
    );
  }
  if (kind === 'text' && run.outputText.trim().length > 0) {
    return report(kind, run, req, 'pass', 'The model returned text.', errorCode);
  }
  if (kind === 'image' && run.images.length > 0) {
    return report(kind, run, req, 'pass', 'The model returned an image.', errorCode);
  }
  return report(
    kind,
    run,
    req,
    'error',
    'The response completed without the expected output.',
    errorCode,
  );
}

function report(
  kind: ProbeKind,
  run: ResponsesRun,
  req: ResponsesBody,
  verdict: Verdict,
  reason: string,
  errorCode: string | undefined,
): ProbeReport {
  const evidence: ProbeReport['evidence'] = {
    httpStatus: run.httpStatus,
    eventTypes: eventRuns(run),
  };
  if (errorCode) evidence.errorCode = errorCode;
  if (run.terminal) evidence.terminal = run.terminal;
  if (run.errorBody !== undefined) evidence.errorBody = summarize(run.errorBody);
  const result: ProbeReport = {
    kind,
    verdict,
    reason,
    evidence,
    request: requestSummary(req),
    durationMs: run.durationMs,
  };
  if (verdict === 'pass' && kind === 'text') result.output = run.outputText;
  const image = run.images[0];
  if (verdict === 'pass' && kind === 'image' && image) {
    result.imageDataUrl = `data:${image.mime};base64,${image.b64}`;
  }
  return result;
}

function requestSummary(req: ResponsesBody): ProbeReport['request'] {
  const tools = (req.tools ?? []).map((tool) =>
    isRecord(tool) && typeof tool.type === 'string' ? tool.type : 'unknown',
  );
  return { model: req.model, tools, toolChoice: toolChoiceLabel(req.tool_choice) };
}

function toolChoiceLabel(choice: unknown): string {
  if (typeof choice === 'string' && choice.length > 0) return choice;
  if (isRecord(choice) && typeof choice.type === 'string') return choice.type;
  return 'unset';
}

function eventRuns(run: ResponsesRun): string[] {
  const types: string[] = [];
  for (const event of run.events) {
    if (types.at(-1) !== event.type) types.push(event.type);
  }
  return types;
}

function routeRejected(code: string | undefined): boolean {
  return code === 'route_not_supported' || (!!code && code.endsWith('route_not_supported'));
}

function clientRejectedTool(run: ResponsesRun): boolean {
  return (run.httpStatus === 400 || run.httpStatus === 403) && namesImageTool(run);
}

function namesImageTool(run: ResponsesRun): boolean {
  const text = messages(run).join('\n');
  if (/image_generation/i.test(text)) return true;
  return /unsupported/i.test(text) && /tool/i.test(text);
}

function unsupportedReason(code: string | undefined): string {
  if (routeRejected(code)) return `The Responses route rejected image generation (${code}).`;
  return 'The Responses route rejected the image_generation tool.';
}

function isStreamTimeout(run: ResponsesRun): boolean {
  return messages(run).includes('stream timeout');
}

function findErrorCode(run: ResponsesRun): string | undefined {
  const fromBody = codeOf(run.errorBody);
  if (fromBody) return fromBody;
  for (const event of run.events) {
    if (event.type !== 'response.failed' && event.type !== 'error') continue;
    const code = codeOf(event.data);
    if (code) return code;
  }
  return undefined;
}

function codeOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code === 'string' && value.code.length > 0) return value.code;
  if (value.error !== undefined) {
    const nested = codeOf(value.error);
    if (nested) return nested;
  }
  if (isRecord(value.response)) return codeOf(value.response.error ?? value.response);
  return undefined;
}

function messages(run: ResponsesRun): string[] {
  const out: string[] = [];
  collectMessages(run.errorBody, out, 0);
  for (const event of run.events) {
    if (event.type === 'response.failed' || event.type === 'error')
      collectMessages(event.data, out, 0);
  }
  return out;
}

function collectMessages(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || value === undefined || value === null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.message === 'string') out.push(value.message);
  if (value.error !== undefined) collectMessages(value.error, out, depth + 1);
  if (value.response !== undefined) collectMessages(value.response, out, depth + 1);
}
