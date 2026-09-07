// The two lanes, side by side. This is the demo's argument in one panel.
//
// The right lane is rendered from `manifest` in src/proposed/placeholders.ts, and the left
// from the same entry's `route` plus the LIVE count of internal reaches the trace has
// recorded for that capability. Neither column is written by hand here, so the comparison
// cannot drift away from what the code actually did.
import type { Capability, TraceEntry } from "@/internal/trace";
import { type ManifestEntry, manifest } from "@/proposed/placeholders";

/** Which capability's trace entries evidence each proposed member. */
const CAPABILITY_FOR_SIGNATURE: Record<string, Capability> = {
  "doc.placeholders.all()": "scan",
  "doc.placeholders.add({ key, fromSelection })": "mint",
  "doc.placeholders.findCandidates(selection)": "occurrences",
  'add({ key, occurrences: "all" | { ordinals: [0, 2] } | { limit: n } })': "mint",
  "placeholder.anchors  // TextAnchorRange[]": "occurrences",
  "placeholder.protected = true": "guard",
  "placeholder.rects()": "paint",
  "placeholder.style = { background, border }": "paint",
  'doc.placeholders.on("click", handler)': "paint",
  "placeholder.scrollIntoView()": "scroll",
  "placeholder.range()": "mint",
  'doc.placeholders.on("change", handler)': "sync",
};

const STATUS_LABEL: Record<ManifestEntry["status"], string> = {
  shim: "worked around",
  degraded: "partly",
  unreachable: "no route",
};

type Props = {
  trace: readonly TraceEntry[];
  /** Capability the user's last action exercised, so its row can be marked live. */
  liveCapability: Capability | null;
};

export function ComparisonPanel({ trace, liveCapability }: Props) {
  const reachesFor = (signature: string): { distinct: number; calls: number } | null => {
    const capability = CAPABILITY_FOR_SIGNATURE[signature];
    if (!capability) return null;
    const matching = trace.filter((entry) => entry.capability === capability);
    if (matching.length === 0) return null;
    return {
      distinct: matching.length,
      calls: matching.reduce((total, entry) => total + entry.count, 0),
    };
  };

  return (
    <div className="lanes">
      <div className="lane-head">
        <span className="l">Today · what the demo actually does</span>
        <span className="r">Proposed · what it should have called</span>
      </div>

      {manifest.map((entry) => {
        const capability = CAPABILITY_FOR_SIGNATURE[entry.signature];
        const reaches = reachesFor(entry.signature);
        const isLive = liveCapability !== null && capability === liveCapability;
        return (
          <div className={`row${isLive ? " live" : ""}`} key={entry.signature}>
            <div className="cols">
              <div className="cell l">
                <span className={`tag ${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                <div className="route">{entry.route}</div>
                {reaches && (
                  <div className="reach-count">
                    {reaches.distinct} distinct internal reach{reaches.distinct === 1 ? "" : "es"}
                    {reaches.calls > reaches.distinct ? `, ${reaches.calls} calls` : ""} so far
                  </div>
                )}
              </div>
              <div className="cell r">
                <span className="tag ask">ask {entry.ask}</span>
                <div className="sig">{entry.signature}</div>
                <div className="purpose">{entry.purpose}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
