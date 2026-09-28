import type { JSONSchema, UiMeta, ValueExpr } from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";
import {
  type ComponentType,
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { FlowkitClientContext } from "./hooks";
import { type IconComponent, resolveIconIn } from "./icons";
import { defaultLabels, type FlowkitLabels, resolveLabels } from "./labels";
import type { FlowkitTheme } from "./theme";

/** Props given to a config field widget registered with {@link FlowkitProvider}. */
export interface FieldWidgetProps {
  /** Current value (a literal, `{ $ref }`, `{ $tpl }`, …), `undefined` when unset. */
  value: ValueExpr | undefined;
  /** Sets the value; `undefined` removes the field from config. */
  onChange(v: ValueExpr | undefined): void;
  /** The field's JSON Schema. */
  schema: JSONSchema;
  /** The field's editor hints (`x-flowkit`). */
  meta: UiMeta;
  /** ID of the step being configured (`"__trigger"` for the trigger). */
  stepId: string;
  /** The field's key in config. */
  fieldKey: string;
  /** Render without editing affordances. */
  readOnly?: boolean;
}

/** A custom config field control, selected by `x-flowkit.widget` in a field's schema. */
export type FieldWidget = ComponentType<FieldWidgetProps>;

/** A notice Flowkit would show as a toast (see `<FlowkitProvider onNotify>`). */
export interface FlowkitNotice {
  /** The text, already in the provider's `labels`. */
  message: string;
  /** `success` (saved, published, run started…), `danger` (a failed action) or `neutral`. */
  tone: "neutral" | "success" | "danger";
  /** An action to offer with it, e.g. Undo after deleting a step. */
  action?: { label: string; run(): void };
  /** The component that raised it. */
  source: "editor" | "runViewer" | "canvas";
}

/**
 * Receives Flowkit's notices instead of its built-in toast. Return `false` to let Flowkit show
 * this one itself.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` so any plain handler (no return) fits; `false` opts back into the built-in toast.
export type NotifyHandler = (notice: FlowkitNotice) => void | false;

interface FlowkitContextValue {
  client: FlowkitClient;
  widgets: Record<string, FieldWidget>;
  theme: FlowkitTheme;
  labels: FlowkitLabels;
  resolveIcon(name?: string): IconComponent;
  onNotify?: NotifyHandler;
}

const FlowkitContext = createContext<FlowkitContextValue | null>(null);

const NO_WIDGETS: Record<string, FieldWidget> = {};
const NO_THEME: FlowkitTheme = {};

/**
 * Supplies the HTTP client, theme, text, custom field widgets and icons to every Flowkit
 * component below it. Place it once near the root of the part of your app that embeds Flowkit.
 *
 * @example
 * <FlowkitProvider
 *   client={createClient({ baseUrl: "/api/flowkit" })}
 *   theme={{ colorMode: "dark" }}
 *   labels={{ addStep: "Schritt hinzufügen", delete: "Löschen" }}
 *   icons={{ rocket: Rocket }}
 * >
 *   <WorkflowEditor workflowId="welcome" />
 * </FlowkitProvider>
 */
export function FlowkitProvider(props: {
  client: FlowkitClient;
  theme?: FlowkitTheme;
  /**
   * Overrides for any of the UI's visible and accessible text (English by default), for
   * translation or wording changes. Keep the object stable (memoize it) across renders.
   */
  labels?: Partial<FlowkitLabels>;
  widgets?: Record<string, FieldWidget>;
  /**
   * Icons by manifest icon name (exact, or kebab-case: `"rocket"` also matches `"Rocket"`),
   * taking precedence over the bundled ones. Only a set of common Lucide icons is bundled (see
   * `bundledIconNames`); any other name needs an entry here, or it shows a generic box. Icons
   * are never loaded by name at runtime, so your bundle only contains the icons you use.
   *
   * @example icons={{ rocket: Rocket, "my-crm": CrmLogo }}
   */
  icons?: Record<string, ComponentType<{ size?: number }>>;
  /**
   * Routes Flowkit's notices ("Saved as v3", "Run resumed", "Deleted “Send email” · Undo", errors) to
   * your app's own toasts instead of Flowkit's. Without it Flowkit shows them itself. Return
   * `false` for a notice to have Flowkit show it after all.
   *
   * @example onNotify={(n) => toast[n.tone === "danger" ? "error" : "info"](n.message)}
   */
  onNotify?: NotifyHandler;
  children: ReactNode;
}): JSX.Element {
  const { client, theme = NO_THEME, widgets = NO_WIDGETS, icons, labels, children } = props;
  const { onNotify } = props;
  const resolved = useMemo(() => resolveLabels(labels), [labels]);
  const value = useMemo<FlowkitContextValue>(
    () => ({
      client,
      widgets,
      theme,
      labels: resolved,
      resolveIcon: (name) => resolveIconIn(icons, name),
      ...(onNotify ? { onNotify } : {}),
    }),
    [client, widgets, theme, resolved, icons, onNotify],
  );
  return (
    <FlowkitClientContext.Provider value={client}>
      <FlowkitContext.Provider value={value}>{children}</FlowkitContext.Provider>
    </FlowkitClientContext.Provider>
  );
}

/**
 * The client, field widgets and icon resolver from the nearest {@link FlowkitProvider}.
 * `resolveIcon` tries the provider's `icons`, then the bundled Lucide icons, then a neutral box.
 * @throws If there is no `<FlowkitProvider>` above.
 */
export function useFlowkit(): {
  client: FlowkitClient;
  widgets: Record<string, FieldWidget>;
  resolveIcon(name?: string): IconComponent;
} {
  const ctx = useContext(FlowkitContext);
  if (!ctx) throw new Error("useFlowkit must be used inside <FlowkitProvider>");
  return ctx;
}

const defaultIcon = (name?: string) => resolveIconIn(undefined, name);

const NO_PROVIDER = { theme: NO_THEME, labels: defaultLabels, resolveIcon: defaultIcon };

/**
 * Theme, text, icon resolver and notice handler for components that also work without a
 * provider (the canvas): falls back to the default theme, English labels and the bundled icons.
 * @internal
 */
export function useFlowkitAppearance(): {
  theme: FlowkitTheme;
  labels: FlowkitLabels;
  resolveIcon(name?: string): IconComponent;
  onNotify?: NotifyHandler;
} {
  return useContext(FlowkitContext) ?? NO_PROVIDER;
}
