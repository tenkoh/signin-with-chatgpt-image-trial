export interface ResponsesBody {
  model: string;
  input: unknown;
  store: false;
  stream: true;
  tools?: unknown[];
  tool_choice?: unknown;
}

export function textProbeRequest(model: string): ResponsesBody {
  return {
    model,
    input: [{ role: 'user', content: 'Reply with exactly: pong' }],
    store: false,
    stream: true,
  };
}

export function imageProbeRequest(model: string): ResponsesBody {
  return {
    model,
    input: [{ role: 'user', content: 'A small red circle on white.' }],
    store: false,
    stream: true,
    tools: [{ type: 'image_generation', size: '1024x1024', quality: 'low' }],
    tool_choice: { type: 'image_generation' },
  };
}
