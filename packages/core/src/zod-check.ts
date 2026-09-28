/**
 * Recognising schemas that flowline can't work with: zod 3 schemas (no `_zod`, no `.meta`), or
 * anything else that isn't a zod ≥4 schema. Ruling 73: these are definition errors with advice,
 * never a `TypeError` from deep inside zod.
 *
 * @module
 */
import { z } from "zod";
import { FlowlineDefinitionError } from "./define";

/** The zod version `@flowline/core` runs with, as `major.minor.patch`. */
export const CORE_ZOD_VERSION = `${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}`;

/** How to get to a single zod ≥4 copy. */
export const ZOD_ADVICE =
  'Use a single zod ≥4 instance for your app and flowline: upgrade to zod 4 if you\'re on zod 3 (import from "zod" v4, not "zod/v3"), and dedupe it (`pnpm dedupe`, `npm dedupe`, or an `overrides` entry pinning zod). With a link:/file: dependency, make the linked package resolve your app\'s zod (or install a packed tarball).';

/** @internal Whether `v` looks like a zod 3 schema: a `_def`, a `parse` method, no `_zod`. */
export function isZod3Schema(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const s = v as { _zod?: unknown; _def?: unknown; parse?: unknown };
  return s._zod === undefined && typeof s._def === "object" && typeof s.parse === "function";
}

/**
 * @internal Throws a {@link FlowlineDefinitionError} unless `schema` is a zod ≥4 schema (with a
 * `.meta()` method when `needsMeta`). `subject` names what was being defined, e.g.
 * `'ui()'` or `'field "apiKey" of the input schema of "crm.call"'`.
 */
export function assertZod4(schema: unknown, subject: string, needsMeta = false): void {
  const s = schema as { _zod?: unknown; meta?: unknown } | null | undefined;
  const ok =
    typeof s === "object" &&
    s !== null &&
    typeof s._zod === "object" &&
    (!needsMeta || typeof s.meta === "function");
  if (ok) return;
  const found = isZod3Schema(schema)
    ? "a zod 3 schema"
    : typeof s === "object" && s !== null
      ? "a schema that isn't a zod ≥4 schema"
      : `${s === null ? "null" : typeof s} instead of a zod schema`;
  throw new FlowlineDefinitionError(
    `${subject} got ${found}, but flowline requires zod ≥4 (@flowline/core uses zod ${CORE_ZOD_VERSION}). ${ZOD_ADVICE}`,
  );
}
