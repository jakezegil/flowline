// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subjectOf } from "../run-subject";
import { WelcomeHint } from "./contacts";
import { isValidAddress } from "./outbox";
import { shortName } from "./runs";

afterEach(cleanup);

describe("Runs: workflow filter", () => {
  it("cuts long workflow names at a word boundary", () => {
    expect(shortName("Lead intake")).toBe("Lead intake");
    const long = `Lead intake ${"with a very long qualifier ".repeat(5)}`.trim();
    const short = shortName(long);
    expect(short.length).toBeLessThanOrEqual(40);
    expect(short).toBe("Lead intake with a very long qualifier…");
    expect(shortName("x".repeat(60))).toBe(`${"x".repeat(39)}…`);
  });
});

describe("Runs: what a run is about", () => {
  it("names a run by its contact, deal or lead", () => {
    expect(subjectOf({ contact: { email: "ava@acme.test", firstName: "Ava" } })).toBe(
      "ava@acme.test",
    );
    expect(subjectOf({ contact: { firstName: "Ava", lastName: "Chen", email: "" } })).toBe(
      "Ava Chen",
    );
    expect(subjectOf({ deal: { name: "Acme renewal" }, changes: ["stage"] })).toBe("Acme renewal");
    expect(subjectOf({ email: "lead@navy.test", company: "Navy" })).toBe("lead@navy.test");
    expect(subjectOf({ company: "Navy" })).toBe("Navy");
    expect(subjectOf({ body: { email: "hank@globex.test" }, headers: {} })).toBe(
      "hank@globex.test",
    );
    expect(subjectOf({})).toBeUndefined();
    expect(subjectOf(null)).toBeUndefined();
  });
});

describe("Outbox: recipients", () => {
  it("flags addresses a mail server would reject", () => {
    expect(isValidAddress("ava@acme.test")).toBe(true);
    expect(isValidAddress("ava@acme.testava@acme.test")).toBe(false);
    expect(isValidAddress("ava@acme.test, ben@acme.test")).toBe(false);
    expect(isValidAddress("ava")).toBe(false);
    expect(isValidAddress("")).toBe(false);
  });
});

describe("Contacts: first visit", () => {
  beforeEach(() => localStorage.clear());

  it("points at Workflows and the Webhook tester until dismissed", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <WelcomeHint />
      </MemoryRouter>,
    );
    const hint = screen.getByRole("complementary", { name: "Getting started" });
    expect(hint.querySelector('a[href="/workflows"]')).toBeTruthy();
    expect(hint.querySelector('a[href="/webhook-tester"]')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("complementary", { name: "Getting started" })).toBeNull();
    unmount();

    render(
      <MemoryRouter>
        <WelcomeHint />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("complementary", { name: "Getting started" })).toBeNull();
  });
});
