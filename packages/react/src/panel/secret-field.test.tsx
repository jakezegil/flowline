/**
 * `secret()` fields are literal-only (ruling 68): the manifest carries `literalOnly`, the form
 * offers no reference toggle, and a stored reference shows the validator's issue.
 */
import type { Issue, JSONSchema, Manifest, ValueExpr } from "@flowkit/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import builtin from "../../playground/builtin-manifest.json";
import { mockClient, setupDom } from "../../test/dom";
import { FlowkitProvider } from "../provider";
import { SchemaForm } from "./schema-form";

beforeAll(setupDom);
afterEach(cleanup);

const core = builtin as unknown as Manifest;
const http = core.nodes.find((n) => n.type === "core.httpRequest")?.input as JSONSchema;
const webhook = core.triggers.find((t) => t.type === "core.webhook")?.config as JSONSchema;

type Props = { schema: JSONSchema; value: Record<string, ValueExpr>; issues?: Issue[] };

function renderForm({ schema, value, issues = [] }: Props) {
  const client = mockClient({ listSecrets: async () => ["API_TOKEN"] });
  return render(
    <FlowkitProvider client={client}>
      <SchemaForm
        schema={schema}
        value={value}
        onChange={() => {}}
        stepId="call"
        issues={issues}
        scope={[]}
        samples={{}}
      />
    </FlowkitProvider>,
  );
}

const fieldOf = (el: HTMLElement) => el.closest<HTMLElement>(".fk-f") as HTMLElement;

describe("secret fields", () => {
  test("the manifest marks every built-in secret field literal-only", () => {
    const text = JSON.stringify(core);
    const secrets = [...text.matchAll(/"x-flowkit":\{[^{}]*"secret":true[^{}]*\}/g)];
    expect(secrets.length).toBeGreaterThan(0);
    for (const [meta] of secrets) expect(meta).toContain('"literalOnly":true');
  });

  test("offer no reference toggle", async () => {
    renderForm({ schema: http, value: { auth: { type: "bearer", secret: "API_TOKEN" } } });
    const secret = await screen.findByRole("combobox", { name: /Secret/ });
    expect(
      within(fieldOf(secret)).queryByRole("button", { name: "Use data from earlier steps" }),
    ).toBeNull();
  });

  test("a stored reference shows the validator's issue under the field", async () => {
    const message =
      "\"Signing secret\" is a secret, so it takes a secret's name and can't use a reference";
    renderForm({
      schema: webhook,
      value: { fields: [], secret: { $ref: "trigger.body.key" } },
      issues: [{ code: "config.invalid", severity: "error", message, field: "secret" }],
    });
    const secret = await screen.findByRole("combobox", { name: /Signing secret/ });
    expect(within(fieldOf(secret)).getByText(message)).toBeTruthy();
    expect(
      within(fieldOf(secret)).queryByRole("button", { name: "Use data from earlier steps" }),
    ).toBeNull();
  });
});
