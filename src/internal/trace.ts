// A running log of every SDK-INTERNAL access the demo makes.
//
// This is the point of the demo, so it is instrumented rather than described. Each
// module below calls `trace()` at the moment it reaches past the public API, naming
// what it touched and which public API would have answered instead. The UI groups
// the entries by capability and shows them beside the one-line call that should
// have replaced the whole group.
//
// Nothing here affects behaviour: strip every `trace()` call and the demo works
// identically. It exists so the cost is countable instead of anecdotal.

/** The user-facing capability an internal access was in service of. */
export type Capability =
  | "scan"
  | "paint"
  | "select"
  | "caret"
  | "guard"
  | "occurrences"
  | "preview"
  | "mint"
  | "sync"
  | "zoom"
  | "scroll";

/** How far outside the public API surface one access reaches. */
export type Reach =
  /** A documented public API used in a way it was not designed for. */
  | "public-misuse"
  /** The rendered DOM, located by a CSS heuristic over structure we do not own. */
  | "dom-shape"
  /** A property reached through a `Symbol()` key, matched by the shape of its value. */
  | "symbol-probe"
  /** Fields of the SDK's internal layout tree, whose names are not in any type. */
  | "layout-snapshot"
  /** A behaviour measured empirically because no API reports it. */
  | "measured-constant";

export type TraceEntry = {
  seq: number;
  capability: Capability;
  reach: Reach;
  /** The internal thing touched, spelled the way it appears in the code. */
  touched: string;
  /** Why the public API could not answer this. */
  because: string;
  /** The case's ask this would be covered by, e.g. `02 · A`. */
  ask: string;
  /** Repeats collapse into one entry with a count, so a per-frame repaint stays readable. */
  count: number;
};

type Listener = (entries: readonly TraceEntry[]) => void;

const entries: TraceEntry[] = [];
const byKey = new Map<string, TraceEntry>();
const listeners = new Set<Listener>();
let seq = 0;

/**
 * Record one reach past the public API. Repeat calls with the same
 * (capability, touched) pair increment a count rather than appending — a paint pass
 * that walks 40 parts is one fact about the API, not 40.
 */
export function trace(entry: Omit<TraceEntry, "seq" | "count">): void {
  const key = `${entry.capability}|${entry.touched}`;
  const existing = byKey.get(key);
  if (existing) {
    existing.count++;
  } else {
    const created: TraceEntry = { ...entry, seq: seq++, count: 1 };
    byKey.set(key, created);
    entries.push(created);
  }
  for (const listener of listeners) listener(entries);
}

export function subscribeToTrace(listener: Listener): () => void {
  listeners.add(listener);
  listener(entries);
  return () => void listeners.delete(listener);
}

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

/** Drop everything recorded so far — used when a new document is mounted. */
export function resetTrace(): void {
  entries.length = 0;
  byKey.clear();
  seq = 0;
  for (const listener of listeners) listener(entries);
}
