// The guard's live state — case ask 01 · property 1.
//
// Shows three things, and the third is the point: where we believe the caret is, what the
// guard has refused, and how often it could not decide at all because the shadow caret had
// gone null. That last number is the one to watch: every one of those keystrokes was allowed
// through unexamined, and any of them could have damaged a placeholder.
import type { CaretState } from "@/internal/caretModel";
import type { GuardDecision } from "@/internal/placeholderGuard";

type Props = {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  caret: CaretState | null;
  decisions: readonly GuardDecision[];
};

const REASON_LABEL: Record<GuardDecision["reason"], string> = {
  "backspace-into-marker": "backspace would eat the marker",
  "delete-into-marker": "delete would eat the marker",
  "insert-inside-marker": "insertion inside the marker",
  allowed: "allowed",
  "caret-unknown": "caret unknown — allowed unexamined",
  "not-an-edit": "not an edit",
};

export function GuardPanel({ enabled, onToggle, caret, decisions }: Props) {
  const blocked = decisions.filter((d) => d.blocked);
  const blind = decisions.filter((d) => d.reason === "caret-unknown");
  const inMarker = caret?.markers.find((m) => caret.index > m.start && caret.index < m.end) ?? null;

  return (
    <div className="guard">
      <label className="guard-toggle">
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
        <span>Protect placeholders from editing</span>
      </label>

      {!enabled ? (
        <p className="guard-hint">
          Off. Click into <code>{"{{ effective_date }}"}</code> and type — the marker can be
          half-deleted with no symptom, which is the state ask 01 · property 1 is about.
        </p>
      ) : (
        <>
          <p className="guard-hint">
            Click into the document to seed the caret, then type. Editing inside a marker is
            refused; editing next to one is allowed.
          </p>

          <dl className="guard-stats">
            <div>
              <dt>caret</dt>
              <dd className={caret ? "" : "unknown"}>
                {caret ? `block ${caret.blockRef.blockIndex} · index ${caret.index}` : "unknown"}
              </dd>
            </div>
            <div>
              <dt>inside</dt>
              <dd>{inMarker ? inMarker.text : "—"}</dd>
            </div>
            <div>
              <dt>refused</dt>
              <dd>{blocked.length}</dd>
            </div>
            <div>
              <dt>undecidable</dt>
              <dd className={blind.length > 0 ? "unknown" : ""}>{blind.length}</dd>
            </div>
          </dl>

          {caret === null && (
            <p className="guard-warn">
              The caret model is null, so the guard cannot decide anything — every keystroke is
              passing through unexamined. An arrow key, Home, Enter or a click outside a
              paragraph does this. Click into a paragraph to re-seed it.
            </p>
          )}

          {blind.length > 0 && (
            <p className="guard-warn">
              {blind.length} keystroke{blind.length === 1 ? "" : "s"} allowed without being
              checked. In a real product each of those is a placeholder that may already be
              broken, with nothing to detect it.
            </p>
          )}

          {decisions.length > 0 && (
            <ul className="guard-log">
              {decisions
                .slice(-7)
                .reverse()
                .map((decision, position) => (
                  <li key={`${decisions.length - position}`} className={decision.blocked ? "on" : undefined}>
                    <span className="guard-key">{decision.key === " " ? "space" : decision.key}</span>
                    <span className="guard-at">{decision.index === null ? "—" : `@${decision.index}`}</span>
                    <span className="guard-why">{REASON_LABEL[decision.reason]}</span>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
