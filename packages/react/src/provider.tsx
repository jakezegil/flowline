import type { JSONSchema, UiMeta, ValueExpr } from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";
import { type ComponentType, createContext, type ReactNode, useContext, useMemo } from "react";
import { FlowkitClientContext } from "./hooks";
import { type IconComponent, resolveIconIn } from "./icons";
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
  resolveIcon(name?: string): IconComponent;
}

const FlowkitContext = createContext<FlowkitContextValue | null>(null);

const NO_WIDGETS: Record<string, FieldWidget> = {};
const NO_THEME: FlowkitTheme = {};

/**
 * Supplies the HTTP client, theme, custom field widgets and icons to every Flowkit component
 * below it. Place it once near the root of the part of your app that embeds Flowkit.
 *
 * @example
 * <FlowkitProvider client={createClient({ baseUrl: "/api/flowkit" })} theme={{ colorMode: "dark" }}>
 *   <WorkflowEditor workflowId="welcome" />
 * </FlowkitProvider>
 */
export function FlowkitProvider(props: {
  client: FlowkitClient;
  theme?: FlowkitTheme;
  widgets?: Record<string, FieldWidget>;
  /** Icons by manifest icon name, taking precedence over Lucide icons of the same name. */
  icons?: Record<string, ComponentType<{ size?: number }>>;
  children: ReactNode;
}): ReactNode {
  const { client, theme = NO_THEME, widgets = NO_WIDGETS, icons, children } = props;
  const value = useMemo<FlowkitContextValue>(
    () => ({ client, widgets, theme, resolveIcon: (name) => resolveIconIn(icons, name) }),
    [client, widgets, theme, icons],
  );
  return (
    <FlowkitClientContext.Provider value={client}>
      <FlowkitContext.Provider value={value}>{children}</FlowkitContext.Provider>
    </FlowkitClientContext.Provider>
  );
}

/**
 * The client, field widgets and icon resolver from the nearest {@link FlowkitProvider}.
 * `resolveIcon` tries the provider's `icons`, then Lucide by name, then a neutral box.
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

/**
 * Theme and icon resolver for components that also work without a provider (the canvas):
 * falls back to the default theme and Lucide icons.
 * @internal
 */
export function useFlowkitAppearance(): {
  theme: FlowkitTheme;
  resolveIcon(name?: string): IconComponent;
} {
  const ctx = useContext(FlowkitContext);
  return ctx ?? { theme: NO_THEME, resolveIcon: defaultIcon };
}
