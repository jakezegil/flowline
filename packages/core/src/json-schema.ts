import type { FieldDecl, FieldType, JSONSchema } from "./types";

const FIELD_TYPE_SCHEMA: Record<FieldType, JSONSchema> = {
  string: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  object: { type: "object" },
  array: { type: "array" },
  date: { type: "string", format: "date-time" },
};

/**
 * Build the JSON Schema of an object whose properties are the given user-declared fields.
 * `date` fields become `{ type: "string", format: "date-time" }`. Extra properties are allowed.
 *
 * @example
 * ```ts
 * fieldsToJsonSchema([{ name: "a", type: "date", required: true }]);
 * // { type: "object", properties: { a: { type: "string", format: "date-time" } },
 * //   required: ["a"], additionalProperties: true }
 * ```
 */
export function fieldsToJsonSchema(fields: FieldDecl[]): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = {
      ...FIELD_TYPE_SCHEMA[field.type],
      ...(field.description === undefined ? {} : { description: field.description }),
    };
    if (field.required && !required.includes(field.name)) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}
