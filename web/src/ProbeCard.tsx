import { useState } from 'react';
import { api, type ProbeKind, type ProbeReport } from './api';

export function ProbeCard(props: {
  kind: ProbeKind;
  title: string;
  disabled: boolean;
  report: ProbeReport | null;
  onDone: (r: ProbeReport) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const report = await api.probe(props.kind);
      props.onDone(report);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>{props.title}</h2>
      <button type="button" disabled={props.disabled || busy} onClick={() => void run()}>
        {busy ? 'Running…' : `Run ${props.kind} probe`}
      </button>
      {err ? <p className="reason">{err}</p> : null}
      {props.report ? (
        <>
          <p className={`verdict ${props.report.verdict}`}>{props.report.verdict.toUpperCase()}</p>
          <p className="reason">{props.report.reason}</p>
          {props.report.output ? <pre>{props.report.output}</pre> : null}
          {props.report.imageDataUrl ? (
            <img className="result" alt="Probe image" src={props.report.imageDataUrl} />
          ) : null}
          <details>
            <summary>Evidence</summary>
            <pre>{JSON.stringify(props.report.evidence, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </section>
  );
}
