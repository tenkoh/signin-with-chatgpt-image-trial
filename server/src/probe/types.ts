import type { ProbeKind, ProbeReport, ResponseTerminal, Verdict } from '../public-types.js';

export type { ProbeKind, ProbeReport, ResponseTerminal, Verdict };

export interface SseEventSummary {
  type: string;
  data: unknown;
}

export interface ResponsesRun {
  httpStatus: number;
  errorBody?: unknown;
  events: SseEventSummary[];
  terminal?: ResponseTerminal;
  outputText: string;
  images: { b64: string; mime: string }[];
  durationMs: number;
}
