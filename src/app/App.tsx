// The demo, in one page.
//
// Reading order: this file drives the five things the case describes — mount, scan, paint,
// select, mint — and every one of them goes through `src/internal/`, which is where the cost
// lives. `src/proposed/placeholders.ts` is the API each of them should have called instead.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DocAuthDocument, DocAuthEditor } from "@nutrient-sdk/document-authoring";

import { type BandGroup, MINTED_ACCENT, PLACEHOLDER_ACCENT, clearBands, paintBands } from "@/internal/bandPainter";
import { type ScannedField, scanMarkers } from "@/internal/scanMarkers";
import { findPageDivs, findTokenRects, findViewport, getDocumentContext, pageBoxWidthPx } from "@/internal/snapshotLayout";
import { scrollViewportTo } from "@/internal/shadowDom";
import { type Capability, type TraceEntry, resetTrace, subscribeToTrace, trace } from "@/internal/trace";
import { useTextSelection } from "@/internal/useTextSelection";
import { writeMarkerOverText } from "@/internal/writeMarker";
import { markerFor } from "@/internal/scanMarkers";
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

  const [fixtureUrl, setFixtureUrl] = useState<string>(FIXTURES[0].url);
  const [booted, setBooted] = useState(false);
  const [fields, setFields] = useState<readonly ScannedField[]>([]);
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
      // Chained onto this boot, not fired beside it: the next mount must not start until this
      // editor has actually gone.
      bootChainRef.current = boot.then(() => mounted?.destroy()).catch(() => undefined);
    };
    // `refresh` is stable enough for this: it only reads refs and setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureUrl]);

  // ── scan + resolve geometry ──────────────────────────────────────────────────
  /**
   * Resolve every scanned field's rects. One walk of the internal layout tree per field,
   * because the walkers take a target block and there is no way to ask for many at once.
   */
  const resolveGroups = useCallback(
    (scanned: readonly ScannedField[], minted: ReadonlySet<string>): Map<string, BandGroup> | null => {
      const editor = editorRef.current;
      const container = containerRef.current;
      const resolved = new Map<string, BandGroup>();
      if (!editor || !container) return null;
      const documentContext = getDocumentContext(editor);
      const pageDivs = findPageDivs(container);
      // Null, not an empty map: "the layout is not ready" and "no field could be placed" look
      // identical from here, and reporting the second when it was the first shows every field
      // as unplaceable. The caller keeps what it had instead.
      if (!documentContext || pageDivs.length === 0) return null;
      const pageDivWidthPx = pageBoxWidthPx(pageDivs[0]);

      for (const field of scanned) {
        for (const block of field.blocks) {
          const found = findTokenRects(
            documentContext,
            block.sectionIndex,
            block.blockIndex,
            field.marker,
            pageDivWidthPx,
            block.rowIndex ?? null,
          );
          if (!found || found.rects.length === 0) continue;
          resolved.set(field.key, {
            key: field.key,
            accentHex: minted.has(field.key) ? MINTED_ACCENT : PLACEHOLDER_ACCENT,
            pageIndex: found.pageIndex,
            rects: found.rects,
          });
          break;
        }
      }
      return resolved;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    const scanned = await scanMarkers(doc);
    setFields(scanned);
    const resolved = resolveGroups(scanned, mintedKeysRef.current);
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

  // ── mint ─────────────────────────────────────────────────────────────────────
  const mint = useCallback(
    async (key: string) => {
      const doc = docRef.current;
      if (!doc || !selection) return;
      setBusy(true);
      setLiveCapability("mint");
      try {
        const written = await writeMarkerOverText(
          doc,
          {
            blockRef: selection.blockRef,
            blockText: selection.blockText,
            charStart: selection.charStart,
            charEnd: selection.charEnd,
          },
          markerFor(key),
        );
        if (!written) {
          setFlash({
            kind: "bad",
            text: `Refused to write ${markerFor(key)} — the range could not be confirmed against the model's spelling of the paragraph. See writeMarker.ts.`,
          });
          return;
        }
        clearSelection();
        mintedKeysRef.current.add(key);
        setFlash({ kind: "ok", text: `Wrote ${markerFor(key)} into the document.` });
        // The SDK re-lays out in place; wait for the snapshot to carry the new text.
        await new Promise((resolve) => setTimeout(resolve, RELAYOUT_SETTLE_MS));
        await refresh();
        setSelectedKey(key);
      } finally {
        setBusy(false);
      }
    },
    [selection, clearSelection, refresh],
  );

  // ── scroll to a field ────────────────────────────────────────────────────────
  const reveal = useCallback((key: string) => {
    setSelectedKey(key);
    setLiveCapability("scroll");
    const container = containerRef.current;
    const group = groups.get(key);
    if (!container || !group) return;
    const viewport = findViewport(container);
    const pageDiv = findPageDivs(container)[group.pageIndex];
    if (!viewport || !pageDiv) return;
    const rendered = pageDiv.getBoundingClientRect();
    const scale = pageDiv.offsetHeight > 0 ? rendered.height / pageDiv.offsetHeight : 1;
    const pageTop = rendered.top - viewport.getBoundingClientRect().top;
    // A third of the way down, rather than flush to the top, so the field lands with its
    // surrounding clause visible.
    const target = viewport.scrollTop + pageTop + group.rects[0].top * scale - viewport.clientHeight / 3;
    scrollViewportTo(viewport, target);
  }, [groups]);

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
          busy={busy}
          onMint={(key) => void mint(key)}
          onCancel={clearSelection}
        />
      )}
    </div>
  );
}
