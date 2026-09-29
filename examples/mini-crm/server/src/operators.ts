/**
 * Rule operators the mini CRM adds to the built-in Condition step, registered with
 * `createBuiltinPlugin({ operators })`.
 *
 * @module
 */
import type { CustomOperator } from "@flowlinejs/nodes-builtin";

/**
 * "is unassigned": the value is missing, `null` or `""`. The CRM stores an unowned contact's
 * `ownerId` as `null`; this operator reads better in a condition than "is empty" and also covers
 * an owner field that was never set.
 */
export const isUnassigned: CustomOperator = {
  id: "isUnassigned",
  label: "is unassigned",
  arity: "unary",
  types: ["string", "object", "any"],
  evaluate: (left) => left === null || left === undefined || left === "",
};
