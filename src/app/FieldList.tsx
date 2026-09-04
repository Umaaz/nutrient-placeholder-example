// The author-facing field list — case ask 01 · property 2, "listing them lets us show the
// author a field list that stays in step with the document".
//
// "In step with the document" is the part that costs. There is no event saying a placeholder
// changed, so this list is rebuilt by re-scanning the whole document after every edit, and a
// row's geometry is re-derived from the layout tree each time it is painted. A row showing
// "no geometry" is a field the model found and the layout walkers could not place — usually a
// field inside a table, which the walkers do not descend into.
import type { BandGroup } from "@/internal/bandPainter";
import type { ScannedField } from "@/internal/scanMarkers";

type Props = {
  fields: readonly ScannedField[];
  /** Keyed by field key — absent means the layout walkers could not place it. */
  groups: ReadonlyMap<string, BandGroup>;
  selectedKey: string | null;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
};

export function FieldList({ fields, groups, selectedKey, onHover, onSelect }: Props) {
  if (fields.length === 0) {
    return <p className="empty">No placeholders found. Scan the document, or select a phrase and mint one.</p>;
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
