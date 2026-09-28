/**
 * The `crm.userSelect` config field widget: picks a CRM user for user ID fields (a deal's owner,
 * an approval's approver). The server's plugin names it with `ui(..., { widget: "crm.userSelect" })`
 * and the app registers it on `<FlowlineProvider widgets>`.
 *
 * It is a native `<select>` under a styled face (avatar, name, role), so keyboard use and screen
 * readers work as with any select. A value mapped from workflow data (`{ $ref }` or `{ $tpl }`)
 * is shown as such, with a way back to picking a fixed user.
 *
 * @module
 */
import type { ValueExpr } from "@flowlinejs/core";
import type { FieldWidgetProps } from "@flowlinejs/react";
import { Braces, ChevronsUpDown, TriangleAlert } from "lucide-react";
import { type JSX, useId } from "react";
import { type User, useUsers } from "../api";
import { Avatar } from "../ui";

const TEAM_LABELS: Record<User["team"], string> = {
  smb: "SMB team",
  enterprise: "Enterprise team",
};

/** `"Manager · Enterprise"` style description of a user. */
export function describeUser(u: User): string {
  return `${u.role === "manager" ? "Manager" : "Sales rep"}, ${TEAM_LABELS[u.team]}`;
}

/** The ref path or template text of a mapped value, or `undefined` for a literal. */
function mappedText(value: ValueExpr | undefined): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("$ref" in value && typeof value.$ref === "string") return value.$ref;
    if ("$tpl" in value && typeof value.$tpl === "string") return value.$tpl;
  }
  return undefined;
}

/** Picks a CRM user by ID. See the module docs. */
export function UserSelect(props: FieldWidgetProps): JSX.Element {
  const { value, onChange, meta, readOnly, fieldKey } = props;
  const { users, error } = useUsers();
  const id = useId();
  const label = meta.label ?? fieldKey;

  const mapped = mappedText(value);
  if (mapped !== undefined) {
    return (
      <div className="crm-user-select crm-user-select--mapped">
        <span className="crm-user-select__face">
          <Braces size={14} aria-hidden className="crm-user-select__lead-icon" />
          <span className="crm-user-select__text">
            <span className="crm-user-select__name">Mapped from workflow data</span>
            <code className="crm-user-select__meta">{mapped}</code>
          </span>
        </span>
        {!readOnly && (
          <button
            type="button"
            className="crm-user-select__switch"
            onClick={() => onChange(undefined)}
          >
            Pick a user
          </button>
        )}
      </div>
    );
  }

  const selectedId = typeof value === "string" ? value : "";
  const selected = users?.find((u) => u.id === selectedId);
  const unknown = selectedId !== "" && users !== undefined && !selected;
  const teams = (["enterprise", "smb"] as const).map((team) => ({
    team,
    members: (users ?? []).filter((u) => u.team === team),
  }));

  let face: JSX.Element;
  if (error) {
    face = (
      <span className="crm-user-select__text">
        <span className="crm-user-select__name">Couldn't load users</span>
        <span className="crm-user-select__meta">{error}</span>
      </span>
    );
  } else if (selected) {
    face = (
      <>
        <Avatar name={selected.name} seed={selected.id} size={22} />
        <span className="crm-user-select__text">
          <span className="crm-user-select__name">{selected.name}</span>
          <span className="crm-user-select__meta">{describeUser(selected)}</span>
        </span>
      </>
    );
  } else if (unknown) {
    face = (
      <>
        <TriangleAlert size={14} aria-hidden className="crm-user-select__warn" />
        <span className="crm-user-select__text">
          <span className="crm-user-select__name">Unknown user</span>
          <span className="crm-user-select__meta">{selectedId}</span>
        </span>
      </>
    );
  } else {
    face = (
      <span className="crm-user-select__placeholder">
        {users ? (meta.placeholder ?? "Choose a user") : "Loading users…"}
      </span>
    );
  }

  return (
    <div
      className="crm-user-select"
      data-disabled={readOnly || undefined}
      data-invalid={unknown || undefined}
    >
      <span className="crm-user-select__face" aria-hidden>
        {face}
        <ChevronsUpDown size={14} className="crm-user-select__chevron" />
      </span>
      <select
        id={id}
        aria-label={label}
        className="crm-user-select__native"
        value={selectedId}
        disabled={readOnly || !users}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">Not set</option>
        {unknown && <option value={selectedId}>Unknown user ({selectedId})</option>}
        {teams.map(
          (t) =>
            t.members.length > 0 && (
              <optgroup key={t.team} label={TEAM_LABELS[t.team]}>
                {t.members.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.role === "manager" ? " (manager)" : ""}
                  </option>
                ))}
              </optgroup>
            ),
        )}
      </select>
    </div>
  );
}
