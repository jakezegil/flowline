import type { JSONSchema, UiMeta, ValueExpr } from "@flowline/core";
import type { FlowlineClient } from "@flowline/core/client";
import {
  type ComponentType,
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { FlowlineClientContext } from "./hooks";
import { type IconComponent, resolveIconIn } from "./icons";
import { defaultLabels, type FlowlineLabels, resolveLabels } from "./labels";
import type { FlowlineTheme } from "./theme";

/** Props given to a config field widget registered with {@link FlowlineProvider}. */
export interface FieldWidgetProps {
  /** Current value (a literal, `{ $ref }`, `{ $tpl }`, …), `undefined` when unset. */
  value: ValueExpr | undefined;
  /** Sets the value; `undefined` removes the field from config. */
  onChange(v: ValueExpr | undefined): void;
  /** The field's JSON Schema. */
  schema: JSONSchema;
  /** The field's editor hints (`x-flowline`). */
  meta: UiMeta;
  /** ID of the step being configured (`"__trigger"` for the trigger). */
  stepId: string;
  /** The field's key in config. */
  fieldKey: string;
  /** Render without editing affordances. */
  readOnly?: boolean;
}

/** A custom config field control, selected by `x-flowline.widget` in a field's schema. */
export type FieldWidget = ComponentType<FieldWidgetProps>;

/** A notice Flowline would show as a toast (see `<FlowlineProvider onNotify>`). */
export interface FlowlineNotice {
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
 * Receives Flowline's notices instead of its built-in toast. Return `false` to let Flowline show
 * this one itself.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` so any plain handler (no return) fits; `false` opts back into the built-in toast.
export type NotifyHandler = (notice: FlowlineNotice) => void | false;

interface FlowlineContextValue {
  client: FlowlineClient;
  widgets: Record<string, FieldWidget>;
  theme: FlowlineTheme;
  labels: FlowlineLabels;
  resolveIcon(name?: string): IconComponent;
  onNotify?: NotifyHandler;
}

const FlowlineContext = createContext<FlowlineContextValue | null>(null);

const NO_WIDGETS: Record<string, FieldWidget> = {};
const NO_THEME: FlowlineTheme = {};

/**
 * Supplies the HTTP client, theme, text, custom field widgets and icons to every Flowline
 * component below it. Place it once near the root of the part of your app that embeds Flowline.
 *
 * @example
 * <FlowlineProvider
 *   client={createClient({ baseUrl: "/api/flowline" })}
 *   theme={{ colorMode: "dark" }}
 *   labels={{ addStep: "Schritt hinzufügen", delete: "Löschen" }}
 *   icons={{ rocket: Rocket }}
 * >
 *   <WorkflowEditor workflowId="welcome" />
 * </FlowlineProvider>
 */
export function FlowlineProvider(props: {
  client: FlowlineClient;
  theme?: FlowlineTheme;
  /**
   * Overrides for any of the UI's visible and accessible text (English by default), for
   * translation or wording changes. Keep the object stable (memoize it) across renders.
   */
  labels?: Partial<FlowlineLabels>;
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
   * Routes Flowline's notices ("Saved as v3", "Run resumed", "Deleted “Send email” · Undo", errors) to
   * your app's own toasts instead of Flowline's. Without it Flowline shows them itself. Return
   * `false` for a notice to have Flowline show it after all.
   *
   * @example onNotify={(n) => toast[n.tone === "danger" ? "error" : "info"](n.message)}
   */
  onNotify?: NotifyHandler;
  children: ReactNode;
}): JSX.Element {
  const { client, theme = NO_THEME, widgets = NO_WIDGETS, icons, labels, children } = props;
  const { onNotify } = props;
  const resolved = useMemo(() => resolveLabels(labels), [labels]);
  const value = useMemo<FlowlineContextValue>(
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
    <FlowlineClientContext.Provider value={client}>
      <FlowlineContext.Provider value={value}>{children}</FlowlineContext.Provider>
    </FlowlineClientContext.Provider>
  );
}

/**
 * The client, field widgets and icon resolver from the nearest {@link FlowlineProvider}.
 * `resolveIcon` tries the provider's `icons`, then the bundled Lucide icons, then a neutral box.
 * @throws If there is no `<FlowlineProvider>` above.
 */
export function useFlowline(): {
  client: FlowlineClient;
  widgets: Record<string, FieldWidget>;
  resolveIcon(name?: string): IconComponent;
} {
  const ctx = useContext(FlowlineContext);
  if (!ctx) throw new Error("useFlowline must be used inside <FlowlineProvider>");
  return ctx;
}

const defaultIcon = (name?: string) => resolveIconIn(undefined, name);

const NO_PROVIDER = { theme: NO_THEME, labels: defaultLabels, resolveIcon: defaultIcon };

/**
 * Theme, text, icon resolver and notice handler for components that also work without a
 * provider (the canvas): falls back to the default theme, English labels and the bundled icons.
 * @internal
 */
export function useFlowlineAppearance(): {
  theme: FlowlineTheme;
  labels: FlowlineLabels;
  resolveIcon(name?: string): IconComponent;
  onNotify?: NotifyHandler;
} {
  return useContext(FlowlineContext) ?? NO_PROVIDER;
}
