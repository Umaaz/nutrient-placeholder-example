// The author-facing field list — case ask 01 · property 2, "listing them lets us show the
// author a field list that stays in step with the document".
//
// The `N×` in each row is the field's OCCURRENCE count: one key bound to several positions is
// one field the author fills once, rendered everywhere it appears. Only the first placeable
// occurrence gets a band here, because `findTokenRects` returns on its first hit — a real
// anchor array would carry all of them.
//
// "In step with the document" is the part that costs. There is no event saying a placeholder
// changed, so this list is rebuilt by re-scanning the whole document after every edit, and a
// row's geometry is re-derived from the layout tree each time it is painted. A row showing
// "no geometry" is a field the model found and the layout walkers could not place — usually a
// field inside a table, which the walkers do not descend into.
import type { BandGroup } from "@/internal/bandPainter";
import type { Placeholder } from "@/proposed/placeholders";

type Props = {
  fields: readonly Placeholder[];
  /** Keyed by field key — absent means the layout walkers could not place it. */
  groups: ReadonlyMap<string, BandGroup>;
  selectedKey: string | null;
  /**
   * True when the list is empty only because values are being previewed.
   *
   * Worth distinguishing: an empty list normally means "nothing found", but during a preview
   * it means "the markers are temporarily not there" — which is the same fact ask 01 ·
   * property 2 is about, since the list is derived by scanning for marker text.
   */
  emptyBecausePreviewing?: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
};

export function FieldList({ fields, groups, selectedKey, onHover, onSelect, emptyBecausePreviewing }: Props) {
  if (fields.length === 0) {
    return (
      <p className="empty">
        {emptyBecausePreviewing
          ? "Values are showing, so there are no markers to scan for. Revert on the Fill values tab to get the list back."
          : "No placeholders found. Scan the document, or select a phrase and mint one."}
      </p>
    );
  }
  return (
    <ul className="fields" onPointerLeave={() => onHover(null)}>
      {fields.map((field) => {
        const group = groups.get(field.key);
        return (
          <li key={field.key} className={selectedKey === field.key ? "on" : undefined}>
            <button
              type="button"
              onPointerEnter={() => onHover(field.key)}
              onClick={() => onSelect(field.key)}
            >
              <span
                className="swatch"
                style={{ background: group?.accentHex ?? "var(--rule-strong)" }}
              />
              <span className="key">{field.key}</span>
              <span className={`meta${group ? "" : " nogeo"}`}>
                {group
                  ? `${field.occurrences}× · p${group.pageIndex + 1} · ${group.rects.length} rect${group.rects.length === 1 ? "" : "s"}`
                  : `${field.occurrences}× · no geometry`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
