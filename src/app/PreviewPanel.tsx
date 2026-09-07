// Filling a template in place — case ask 01 · property 5, "can display a value without
// committing it".
//
// The panel exists to make one thing visible: this is not a preview. It is a real edit plus a
// promise to undo it. **Check what a save would contain** performs an actual serialisation and
// reports what came out, which is the direct test of the ask's second half — "the stored DOCX
// keeps the placeholder, not the value".
import { useState } from "react";

import type { PreviewEntry, SaveAudit } from "@/internal/previewValues";
import type { Placeholder } from "@/proposed/placeholders";

type Props = {
  fields: readonly Placeholder[];
  /**
   * The values currently showing, or null when none are.
   *
   * The panel renders from THIS while a preview is live, not from `fields` — because once the
   * values are in the document there are no `{{ … }}` markers left to scan, so `fields` is
   * empty. That is the same consequence ask 01 · property 2 describes ("listing them lets us
   * show the author a field list that stays in step with the document"): the list is derived
   * by scanning for marker text, so filling the template destroys the list of what was
   * filled. Only our own record of the preview survives it — and if that record is lost, so
   * is any way back to the template.
   */
  live: readonly PreviewEntry[] | null;
  busy: boolean;
  audit: SaveAudit | null;
  refusal: string | null;
  onApply: (values: ReadonlyMap<string, string>) => void;
  onRevert: () => void;
  onAudit: () => void;
};

/** A plausible value per key, so the demo is one click rather than a typing exercise. */
const SUGGESTED: Record<string, string> = {
  effective_date: "12 March 2026",
  company_name: "Acme Analytics Ltd",
  company_type: "private limited company",
  company_number: "12345678",
  company_address: "100 Innovation Drive, London",
  return_period_days: "ten (10)",
  notice_period_days: "thirty (30)",
  confidentiality_term: "three (3) years",
  governing_law: "England and Wales",
};

export function PreviewPanel({ fields, live, busy, audit, refusal, onApply, onRevert, onAudit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const valueFor = (key: string) => values[key] ?? SUGGESTED[key] ?? "";
  const filled = fields.filter((field) => valueFor(field.key).length > 0);

  // While a preview is live the rows come from our own record, because the document no longer
  // contains anything to scan for.
  const rows: { key: string; value: string }[] = live
    ? live.map((entry) => ({ key: entry.key, value: entry.value }))
    : fields.map((field) => ({ key: field.key, value: valueFor(field.key) }));

  if (!live && fields.length === 0) {
    return <p className="empty">Scan the document first — there is nothing to fill yet.</p>;
  }

  return (
    <div className="preview">
      {live === null ? (
        <p className="guard-hint">
          Fill values and apply them. They reflow like ordinary text, because the only way to
          make text reflow is to put it in the document — which is exactly the problem.
        </p>
      ) : (
        <p className="preview-live">
          Showing {live.length} value{live.length === 1 ? "" : "s"}. The document holds real
          text now, so <b>the field list above is empty</b> — there are no markers left to
          scan for. These rows come from our own record of the preview, and it is the only way
          back to the template. Any edit to a filled paragraph strands its marker permanently;
          the revert refuses rather than corrupt it.
        </p>
      )}

      <ul className="preview-fields">
        {rows.map((row) => (
          <li key={row.key}>
            <label>
              <span className="preview-key">{row.key}</span>
              <input
                value={row.value}
                spellCheck={false}
                disabled={live !== null || busy}
                placeholder="(leave empty to skip)"
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [row.key]: event.target.value }))
                }
              />
            </label>
          </li>
        ))}
      </ul>

      <div className="preview-actions">
        {live === null ? (
          <button
            type="button"
            className="act primary"
            disabled={busy || filled.length === 0}
            onClick={() =>
              onApply(new Map(filled.map((field) => [field.key, valueFor(field.key)])))
            }
          >
            {busy ? "applying…" : `Fill ${filled.length}`}
          </button>
        ) : (
          <button type="button" className="act primary" disabled={busy} onClick={onRevert}>
            {busy ? "reverting…" : "Revert to placeholders"}
          </button>
        )}
        <button type="button" className="act" disabled={busy || live === null} onClick={onAudit}>
          Check what a save would contain
        </button>
      </div>

      {refusal && <p className="guard-warn">{refusal}</p>}

      {audit && (
        <div className={audit.valuesBaked > 0 ? "preview-audit bad" : "preview-audit ok"}>
          <p>
            Serialised the document as a host would to store it: <b>{audit.markersKept}</b> of{" "}
            {audit.total} placeholders survived, <b>{audit.valuesBaked}</b> were baked in as
            real values.
          </p>
          {audit.valuesBaked > 0 && (
            <p>
              So a save taken right now stores a filled contract, not a template. Nothing in the
              API distinguishes a previewed value from real content, so every one of the five
              export paths has to be wrapped by hand to revert first — and missing one loses the
              template silently.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
