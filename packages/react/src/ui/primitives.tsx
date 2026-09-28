/**
 * Small shared UI pieces of the editor and run viewer: tooltips, dialogs, the ticking clock and
 * error text.
 *
 * @module
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import {
  type JSX,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { PortalContainerContext } from "../canvas/canvas-context";
import { useFlowkitAppearance } from "../provider";

/** A tooltip on `children` (which must accept a ref). No tooltip when `content` is empty. */
export function Hint({
  content,
  children,
  side = "bottom",
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}): JSX.Element {
  const container = useContext(PortalContainerContext);
  if (content === undefined || content === null || content === "") return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content className="fk-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** A small modal dialog with a title, a description, a body and a footer of actions. */
export function SmallDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  /** Makes the body a form; Enter in a single-line field submits. */
  onSubmit?(): void;
}): JSX.Element {
  const container = useContext(PortalContainerContext);
  const { labels } = useFlowkitAppearance();
  const body = (
    <>
      <div className="fk-dialog__head">
        <Dialog.Title className="fk-dialog__title">{title}</Dialog.Title>
        <Dialog.Close className="fk-icon-btn" aria-label={labels.cancel}>
          <X size={16} aria-hidden />
        </Dialog.Close>
      </div>
      {description ? (
        <Dialog.Description className="fk-dialog__desc">{description}</Dialog.Description>
      ) : (
        <Dialog.Description className="fk-sr-only">{title}</Dialog.Description>
      )}
      {children && <div className="fk-dialog__body">{children}</div>}
      <div className="fk-dialog__foot">{footer}</div>
    </>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fk-dialog-overlay" />
        <Dialog.Content className="fk-dialog">
          {onSubmit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
            >
              {body}
            </form>
          ) : (
            body
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The current time, re-read every `everyMs` while `active` (for relative times and live durations). */
export function useNow(everyMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, active]);
  return now;
}

/** The server's message of a failed request (`{ error }` body), else the error's message. */
export function errorText(err: unknown): string {
  const body = (err as { body?: unknown } | null)?.body;
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The HTTP status of a failed client request, if it was one. */
export function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
