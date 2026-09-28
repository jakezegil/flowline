import type { JSX } from "react";

/**
 * The button a not-found state offers, e.g. `{ label: "Back to runs", onClick: () =>
 * navigate("/runs") }`.
 */
export interface NotFoundAction {
  /** Button text. */
  label: string;
  /** Called when the button is clicked. */
  onClick(): void;
}

/** "Workflow not found" / "Run not found", with an optional action. */
export function NotFoundState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: NotFoundAction | null | undefined;
}): JSX.Element {
  return (
    <div className="fk-state" role="alert">
      <p className="fk-state__title">{title}</p>
      <p className="fk-state__detail">{detail}</p>
      {action && (
        <button type="button" className="fk-btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
