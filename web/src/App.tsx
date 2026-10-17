import { useMemo, useState } from 'react';
import { api, type ProbeReport } from './api';
import { ProbeCard } from './ProbeCard';
import { useStatus } from './useStatus';

function statusLabel(status: ReturnType<typeof useStatus>['status']): string {
  switch (status.auth) {
    case 'signed_out':
      return 'Signed out';
    case 'pending':
      return 'Waiting for browser consent…';
    case 'signed_in':
      return `Signed in${status.email ? ` as ${status.email}` : ''}${
        status.planType ? ` (${status.planType})` : ''
      }`;
    case 'plan_disabled':
      return `Signed in${status.email ? ` as ${status.email}` : ''}, plan usage not granted`;
    case 'failed':
      return `Failed: ${status.error}${status.detail ? ` — ${status.detail}` : ''}`;
  }
}

function composeSummary(text: ProbeReport | null, image: ProbeReport | null): string {
  if (!text && !image) {
    return 'Sign in, then run the text probe and the image probe.';
  }
  if (text && text.verdict !== 'pass') {
    return `Text smoke did not complete (${text.verdict}). Image generation was not proven.`;
  }
  if (text?.verdict === 'pass' && !image) {
    return 'Plan usage works for text. Run the image probe next.';
  }
  if (text?.verdict === 'pass' && image?.verdict === 'pass') {
    return 'Plan usage works. Image generation returned an image.';
  }
  if (text?.verdict === 'pass' && image?.verdict === 'unsupported') {
    const code = image.evidence.errorCode ?? 'unsupported';
    return `Plan usage works. Image generation is not supported on this route (${code}).`;
  }
  if (text?.verdict === 'pass' && image) {
    return `Plan usage works. The image attempt failed for another reason (${image.verdict}${
      image.evidence.errorCode ? ` / ${image.evidence.errorCode}` : ''
    }).`;
  }
  return 'Run probes to fill the verdict.';
}

export function App() {
  const { status, error, refresh } = useStatus();
  const [textReport, setTextReport] = useState<ProbeReport | null>(null);
  const [imageReport, setImageReport] = useState<ProbeReport | null>(null);
  const canProbe = status.auth === 'signed_in';
  const summary = useMemo(() => composeSummary(textReport, imageReport), [textReport, imageReport]);

  return (
    <main>
      <h1>SIWC image PoC</h1>
      <p className="lede">
        Measures whether Sign in with ChatGPT plan usage can run the Responses{' '}
        <code>image_generation</code> tool. Tokens stay on the local Hono server.
      </p>
      <p className="summary" data-testid="summary">
        {summary}
      </p>
      <div className="row">
        {status.auth === 'signed_out' ||
        status.auth === 'failed' ||
        status.auth === 'plan_disabled' ||
        status.auth === 'pending' ? (
          <button
            type="button"
            onClick={() => {
              void api.startSignIn().then(refresh);
            }}
          >
            Continue with ChatGPT
          </button>
        ) : null}
        {status.auth === 'signed_in' || status.auth === 'plan_disabled' ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void api.signOut().then(refresh);
              setTextReport(null);
              setImageReport(null);
            }}
          >
            Sign out
          </button>
        ) : null}
        <span className="status">{statusLabel(status)}</span>
      </div>
      {error ? <p className="reason">API error: {error}</p> : null}
      <div className="probes">
        <ProbeCard
          kind="text"
          title="Text smoke"
          disabled={!canProbe}
          report={textReport}
          onDone={setTextReport}
        />
        <ProbeCard
          kind="image"
          title="Image tool"
          disabled={!canProbe}
          report={imageReport}
          onDone={setImageReport}
        />
      </div>
    </main>
  );
}
