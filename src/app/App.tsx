// The demo, in one page.
//
// Written against the API we WANT. Every action below — scan, paint, select, mint,
// scroll-to-field — is a call on the `placeholders` namespace in
// `src/proposed/placeholders.ts`, which is the shape this file wishes the SDK exposed.
//
// That namespace is not a mock. It delegates to `src/internal/`, which is the pile of
// workarounds that has to exist underneath it: a Symbol() probe, a layout-tree walk, text
// hit-testing reimplemented from pointer coordinates, and a range recovered by counting
// searchText matches. So the two lanes in the right-hand panel are the same code path seen
// from both ends — and the reach counters are what the top half costs the bottom.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DocAuthDocument, DocAuthEditor } from "@nutrient-sdk/document-authoring";

import { type BandGroup, MINTED_ACCENT, PLACEHOLDER_ACCENT, clearBands, paintBands } from "@/internal/bandPainter";
import { markerFor } from "@/internal/scanMarkers";
import { findPageDivs } from "@/internal/snapshotLayout";
import { type Capability, type TraceEntry, resetTrace, subscribeToTrace, trace } from "@/internal/trace";
import { useTextSelection } from "@/internal/useTextSelection";
import {
  type OccurrenceSelection,
  type Placeholder,
  type PlaceholderCandidate,
  type PlaceholdersNamespace,
  placeholders,
} from "@/proposed/placeholders";
import { mountEditor } from "@/sdk/mountEditor";

import { ComparisonPanel } from "@/app/ComparisonPanel";
import { FieldList } from "@/app/FieldList";
import { MintCard } from "@/app/MintCard";
import { TracePanel } from "@/app/TracePanel";
import "@/app/styles.css";

const FIXTURES = [
  { url: "/fixtures/acme_nda_blueprint.docx", label: "acme_nda_blueprint.docx — 9 fields already marked up" },
  { url: "/fixtures/acme_nda.docx", label: "acme_nda.docx — plain; mint fields into it yourself" },
  {
    url: "/fixtures/multi-section-nda.docx",
    label: "multi-section-nda.docx — minting past a section break is REFUSED",
  },
] as const;

/** The SDK re-lays the page out in place after a write; the snapshot carries it within ~400ms. */
const RELAYOUT_SETTLE_MS = 450;
/** `content.change` says only that *something* changed, so edits are coalesced. */
const CHANGE_DEBOUNCE_MS = 300;

type Flash = { kind: "ok" | "bad"; text: string } | null;

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DocAuthEditor | null>(null);
  const docRef = useRef<DocAuthDocument | null>(null);
  /** The proposed API, bound to the mounted document. Every action goes through it. */
  const apiRef = useRef<PlaceholdersNamespace | null>(null);

  const [fixtureUrl, setFixtureUrl] = useState<string>(FIXTURES[0].url);
  const [booted, setBooted] = useState(false);
  const [fields, setFields] = useState<readonly Placeholder[]>([]);
  const [groups, setGroups] = useState<ReadonlyMap<string, BandGroup>>(new Map());
  // Which fields the user minted in this session, so a new one paints in a distinct accent.
  // A ref, not state: `refresh` reads it and no render depends on it directly.
  const mintedKeysRef = useRef<Set<string>>(new Set());
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [traceEntries, setTraceEntries] = useState<readonly TraceEntry[]>([]);
  const [liveCapability, setLiveCapability] = useState<Capability | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  /** Every occurrence of the phrase under the current selection, for the mint card's picker. */
  const [candidates, setCandidates] = useState<readonly PlaceholderCandidate[]>([]);

  useEffect(() => subscribeToTrace((entries) => setTraceEntries([...entries])), []);

  const { selection, anchor, clear: clearSelection } = useTextSelection({
    containerRef,
    editorRef,
    enabled: booted,
  });

  // ── mount ────────────────────────────────────────────────────────────────────
  // Boots are SERIALIZED through this promise chain. Two `createEditor` passes against the
  // same container clobber each other, and React StrictMode deliberately runs this effect
  // twice in development — so the second mount waits for the first one's teardown instead of
  // racing it. Without this the editor intermittently comes up with an empty container.
  const bootChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let mounted: Awaited<ReturnType<typeof mountEditor>> | null = null;
    let changeTimer: ReturnType<typeof setTimeout> | null = null;

    setBooted(false);
    setFields([]);
    setGroups(new Map());
    mintedKeysRef.current = new Set();
    setSelectedKey(null);
    setHoveredKey(null);
    setFlash(null);
    resetTrace();

    const boot = bootChainRef.current.then(async () => {
      if (cancelled) return;
      try {
        mounted = await mountEditor({
          container,
          url: fixtureUrl,
          isCancelled: () => cancelled,
          // No payload, so the only possible reaction is to redo everything. Ask 02 · C.
          onContentChange: () => {
            if (changeTimer) clearTimeout(changeTimer);
            changeTimer = setTimeout(() => {
              trace({
                capability: "sync",
                reach: "public-misuse",
                touched: 'editor.on("content.change") → full re-scan and re-derive',
                because:
                  "The event is typed void and fires with no arguments, so nothing says which range changed. Every placeholder in the document is re-scanned and its geometry re-derived from scratch.",
                ask: "02 · C",
              });
              setLiveCapability("sync");
              void refresh();
            }, CHANGE_DEBOUNCE_MS);
          },
        });
        if (cancelled) return;
        editorRef.current = mounted.editor;
        docRef.current = mounted.doc;
        apiRef.current = placeholders(mounted.doc, mounted.editor, container);
        setBooted(true);
      } catch (error) {
        if (!cancelled) setFlash({ kind: "bad", text: `Could not load the document: ${String(error)}` });
      }
    });
    bootChainRef.current = boot.catch(() => undefined);

    return () => {
      cancelled = true;
      if (changeTimer) clearTimeout(changeTimer);
      editorRef.current = null;
      docRef.current = null;
      apiRef.current = null;
      // Chained onto this boot, not fired beside it: the next mount must not start until this
      // editor has actually gone.
      bootChainRef.current = boot.then(() => mounted?.destroy()).catch(() => undefined);
    };
    // `refresh` is stable enough for this: it only reads refs and setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureUrl]);

  // ── scan + resolve geometry ──────────────────────────────────────────────────
  /**
   * Turn the placeholder list into paintable band groups.
   *
   * `placeholder.rects()` is one walk of the internal layout tree PER PLACEHOLDER — the
   * walker takes a single target block and there is no way to ask it for several at once. So
   * this loop is O(fields) full traversals of the document's layout every time anything
   * changes.
   */
  const resolveGroups = useCallback(
    (list: readonly Placeholder[], minted: ReadonlySet<string>): Map<string, BandGroup> | null => {
      const container = containerRef.current;
      // Null, not an empty map: "the layout is not ready" and "no field could be placed" look
      // identical from here, and reporting the second when it was the first shows every field
      // as unplaceable. The caller keeps what it had instead.
      if (!container || findPageDivs(container).length === 0) return null;

      const resolved = new Map<string, BandGroup>();
      for (const placeholder of list) {
        const found = placeholder.rects();
        if (!found || found.rects.length === 0) continue;
        resolved.set(placeholder.key, {
          key: placeholder.key,
          accentHex: minted.has(placeholder.key) ? MINTED_ACCENT : PLACEHOLDER_ACCENT,
          pageIndex: found.pageIndex,
          rects: found.rects,
        });
      }
      return resolved;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    const list = await api.all();
    setFields(list);
    const resolved = resolveGroups(list, mintedKeysRef.current);
    if (resolved) setGroups(resolved);
  }, [resolveGroups]);

  const scan = useCallback(async () => {
    setBusy(true);
    setLiveCapability("scan");
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ── paint ────────────────────────────────────────────────────────────────────
  const bandGroups = useMemo(() => [...groups.values()], [groups]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !booted) return;
    const pageDivs = findPageDivs(container);
    paintBands({
      pageDivs,
      groups: bandGroups,
      state: { hoveredKey, selectedKey },
      onBandClick: (key) => {
        setSelectedKey(key);
        setLiveCapability("paint");
      },
      onBandHover: setHoveredKey,
      animateEntrance: hoveredKey === null && selectedKey === null,
    });
    return () => clearBands(pageDivs);
  }, [bandGroups, hoveredKey, selectedKey, booted]);

  // No zoom event exists, so a repaint has to be provoked by anything that might have been a
  // zoom. A ResizeObserver on the container does not fire when only the page's own box
  // changed. Ask 02 · D.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !booted) return;
    const repaint = () => {
      trace({
        capability: "zoom",
        reach: "measured-constant",
        touched: "window resize / wheel as a stand-in for a zoom event",
        because:
          "Zoom emits no event and a ResizeObserver does not fire for it, so overlay geometry is recomputed on whatever unrelated signal is available. Between those signals the bands are stale.",
        ask: "02 · D",
      });
      void refresh();
    };
    window.addEventListener("resize", repaint);
    return () => window.removeEventListener("resize", repaint);
  }, [booted, refresh]);

  // ── occurrences of the current selection ────────────────────────────────────
  // Looked up as soon as a selection exists, so the mint card can offer a choice between
  // repeats. `findCandidates` is a whole extra document walk, because `searchText` reports no
  // offset, ordinal or count — see `findOccurrences.ts`.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !selection) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setLiveCapability("occurrences");
    void (async () => {
      const found = await api.findCandidates({
        blockRef: selection.blockRef,
        blockText: selection.blockText,
        charStart: selection.charStart,
        charEnd: selection.charEnd,
      });
      if (!cancelled) setCandidates(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [selection]);

  // ── mint ─────────────────────────────────────────────────────────────────────
  const mint = useCallback(
    async (key: string, occurrences: OccurrenceSelection) => {
      const api = apiRef.current;
      if (!api || !selection) return;
      setBusy(true);
      setLiveCapability("mint");
      try {
        const { written, refusal } = await api.add({
          key,
          from: {
            blockRef: selection.blockRef,
            blockText: selection.blockText,
            charStart: selection.charStart,
            charEnd: selection.charEnd,
          },
          occurrences,
          // The list the author was actually shown. Without this the ordinals they picked
          // would be re-resolved against the document as it reads at write time.
          against: candidates,
        });
        if (refusal !== null) {
          // The write is all-or-nothing, so nothing was changed. Keep the card open: the
          // request was reasonable and the user may want to retry a narrower one.
          setFlash({ kind: "bad", text: `Refused to write ${markerFor(key)} — ${refusal}` });
          return;
        }
        clearSelection();
        mintedKeysRef.current.add(key);
        setFlash({
          kind: "ok",
          text:
            written === 1
              ? `Wrote ${markerFor(key)} into the document.`
              : `Wrote ${markerFor(key)} over ${written} occurrences — one field, ${written} anchors.`,
        });
        // The SDK re-lays out in place; wait for the snapshot to carry the new text.
        await new Promise((resolve) => setTimeout(resolve, RELAYOUT_SETTLE_MS));
        await refresh();
        setSelectedKey(key);
      } finally {
        setBusy(false);
      }
    },
    [selection, candidates, clearSelection, refresh],
  );

  // ── scroll to a field ────────────────────────────────────────────────────────
  const reveal = useCallback(
    (key: string) => {
      setSelectedKey(key);
      setLiveCapability("scroll");
      const group = groups.get(key);
      if (!group) return;
      apiRef.current?.scrollIntoView(group.pageIndex, group.rects[0].top);
    },
    [groups],
  );

  const withGeometry = bandGroups.length;

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Document placeholders on Nutrient Document Authoring</h1>
        <span className="sdk">SDK 1.19.1</span>
        <div className="spacer" />
        <div className="picker">
          <label htmlFor="fixture">document</label>
          <select
            id="fixture"
            value={fixtureUrl}
            onChange={(event) => setFixtureUrl(event.target.value)}
          >
            {FIXTURES.map((fixture) => (
              <option key={fixture.url} value={fixture.url}>
                {fixture.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="act primary" disabled={!booted || busy} onClick={() => void scan()}>
          {busy ? "working…" : "Scan for placeholders"}
        </button>
      </header>

      <div className="body">
        <div className="canvas-col">
          <div className="canvas-host" ref={containerRef} />
          {!booted && <div className="canvas-boot">loading the SDK and the document…</div>}
          <p className="hint">
            <b>Drag across a phrase</b> to mint a field, or <b>double-click a word</b>. Hover a
            row on the right to emphasise its bands; click one to scroll to it. Every highlight
            you see is our own <code>div</code>, positioned from the SDK's internal layout tree.
          </p>
        </div>

        <aside className="rail">
          {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}

          <section className="rail-section fields-section">
            <header>
              <h2>Fields</h2>
              <span className="count">
                {fields.length} found · {withGeometry} placed
              </span>
            </header>
            <div className="rail-scroll">
              <FieldList
                fields={fields}
                groups={groups}
                selectedKey={selectedKey}
                onHover={setHoveredKey}
                onSelect={reveal}
              />
            </div>
          </section>

          <section className="rail-section lanes-section">
            <header>
              <h2>What that cost</h2>
              <span className="count">ask 01 &amp; 02</span>
            </header>
            <div className="rail-scroll">
              <ComparisonPanel trace={traceEntries} liveCapability={liveCapability} />
            </div>
          </section>

          <section className="rail-section trace-section">
            <header>
              <h2>Internal reaches, as they happened</h2>
              <span className="count">{traceEntries.length}</span>
            </header>
            <div className="rail-scroll">
              <TracePanel trace={traceEntries} />
            </div>
          </section>
        </aside>
      </div>

      {selection && anchor && (
        <MintCard
          anchor={anchor}
          selectedText={selection.text}
          candidates={candidates}
          busy={busy}
          onMint={(key, occurrences) => void mint(key, occurrences)}
          onCancel={clearSelection}
        />
      )}
    </div>
  );
}
