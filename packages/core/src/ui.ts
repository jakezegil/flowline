import { z } from "zod";
import { isRef, isTpl } from "./refs";
import type { FieldDecl, JSONSchema, Literal, ShowIf, UiMeta } from "./types";

const asList = (v: Literal | Literal[]): Literal[] => (Array.isArray(v) ? v : [v]);

/**
 * Whether a field with {@link UiMeta.showIf} `cond` applies, given its object's `values` and the
 * object schema's `properties` (for the sibling's `default`). No condition: `true`. The editor
 * renders, and the validator checks, only fields that apply.
 *
 * @example
 * isFieldShown({ field: "bodyType", notEquals: "none" }, { bodyType: "json" }); // true
 */
export function isFieldShown(
  cond: ShowIf | undefined,
  values: Record<string, unknown> | undefined,
  properties?: Record<string, unknown>,
): boolean {
  if (!cond || typeof cond !== "object" || typeof cond.field !== "string") return true;
  let value = values?.[cond.field];
  if (value === undefined) {
    const prop = properties?.[cond.field];
    if (typeof prop === "object" && prop !== null) value = (prop as JSONSchema).default;
  }
  if (isRef(value) || isTpl(value)) return true;
  if (cond.equals !== undefined) return asList(cond.equals).some((v) => v === value);
  if (cond.notEquals !== undefined) return !asList(cond.notEquals).some((v) => v === value);
  return value !== undefined && value !== null && value !== "" && value !== false;
}

/** JSON Schema / Zod metadata key under which {@link UiMeta} travels. */
export const UI_META_KEY = "x-flowkit";

/**
 * Attach editor hints to a field schema. The hints travel in the manifest's JSON Schema under
 * `"x-flowkit"` on the property. Calling `ui` on a schema that already has hints merges them
 * (later keys win). Returns a new schema of the same type; the argument is not modified, so one
 * base schema can be reused with different hints.
 *
 * Wrap the inner schema and chain modifiers afterwards: `ui(z.string(), { label: "Email" }).optional()`.
 *
 * @example
 * ```ts
 * z.object({ contactId: ui(z.string(), { label: "Contact", widget: "crm.contactSelect" }) })
 * ```
 */
export function ui<T extends z.ZodType>(schema: T, meta: UiMeta): T {
  const previous = schema.meta()?.[UI_META_KEY] as UiMeta | undefined;
  return schema.meta({ [UI_META_KEY]: { ...previous, ...meta } });
}

/**
 * A string field holding the *name* of a host-provided secret (resolved at runtime via
 * `ctx.secrets.get(name)`). Secret values never appear in workflow docs.
 */
export function secret(schema: z.ZodString = z.string()): z.ZodString {
  return ui(schema, { secret: true, widget: "secret" });
}

/** Mark a field as sensitive: its value is masked in run inspection and audit output. */
export function sensitive<T extends z.ZodType>(schema: T): T {
  return ui(schema, { sensitive: true });
}

/**
 * Zod schema for a user-editable list of field declarations ({@link FieldDecl}[]), rendered with the
 * `"fields"` widget. Parsed values are `FieldDecl[]`. Field names must be identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`) so they can be
 * used in reference paths. Pair with `dynamicOutput: { kind: "fields", configPath }`.
 */
export function fields(): z.ZodArray<
  z.ZodObject<{
    name: z.ZodString;
    type: z.ZodEnum<{ [K in FieldDecl["type"]]: K }>;
    required: z.ZodOptional<z.ZodBoolean>;
    description: z.ZodOptional<z.ZodString>;
  }>
> {
  return ui(
    z.array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Field names must be identifiers"),
        type: z.enum(["string", "number", "boolean", "object", "array", "date"]),
        required: z.boolean().optional(),
        description: z.string().optional(),
      }),
    ),
    { widget: "fields" },
  );
}
