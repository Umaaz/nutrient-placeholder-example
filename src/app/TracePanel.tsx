// Every reach past the public API, in the order it first happened.
//
// Recorded by `trace()` at the moment each one fires, so this is a log of what the demo did,
// not a description of what it might do. An empty list means the demo has not yet been asked
// to do anything — press Scan.
import type { Reach, TraceEntry } from "@/internal/trace";

const REACH_LABEL: Record<Reach, string> = {
  "public-misuse": "public API, misused",
  "dom-shape": "rendered DOM shape",
  "symbol-probe": "Symbol() probe",
  "layout-snapshot": "internal layout tree",
  "measured-constant": "measured, not reported",
};

export function TracePanel({ trace }: { trace: readonly TraceEntry[] }) {
  if (trace.length === 0) {
    return <p className="empty">Nothing yet. Scan the document to start the log.</p>;
  }
  return (
    <ul className="trace">
      {trace.map((entry) => (
        <li key={`${entry.capability}|${entry.touched}`}>
          <div className="strip">
            <span className="reach">{REACH_LABEL[entry.reach]}</span>
            <span className="tag ask">ask {entry.ask}</span>
            {entry.count > 1 && <span className="n">&times;{entry.count}</span>}
          </div>
          <div className="touched">{entry.touched}</div>
          <div className="because">{entry.because}</div>
        </li>
      ))}
    </ul>
  );
}
