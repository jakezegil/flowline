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

interface FlowkitContextValue {
  client: FlowkitClient;
  widgets: Record<string, FieldWidget>;
  theme: FlowkitTheme;
  labels: FlowkitLabels;
  resolveIcon(name?: string): IconComponent;
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
  children: ReactNode;
}): JSX.Element {
  const { client, theme = NO_THEME, widgets = NO_WIDGETS, icons, labels, children } = props;
  const resolved = useMemo(() => resolveLabels(labels), [labels]);
  const value = useMemo<FlowkitContextValue>(
    () => ({
      client,
      widgets,
      theme,
      labels: resolved,
      resolveIcon: (name) => resolveIconIn(icons, name),
    }),
    [client, widgets, theme, resolved, icons],
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
 * Theme, text and icon resolver for components that also work without a provider (the
 * canvas): falls back to the default theme, English labels and the bundled icons.
 * @internal
 */
export function useFlowkitAppearance(): {
  theme: FlowkitTheme;
  labels: FlowkitLabels;
  resolveIcon(name?: string): IconComponent;
} {
  return useContext(FlowkitContext) ?? NO_PROVIDER;
}
