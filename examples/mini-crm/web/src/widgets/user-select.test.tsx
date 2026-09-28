// @vitest-environment jsdom
import type { FieldWidgetProps } from "@flowline/react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../api";
import { UserSelect } from "./user-select";

const USERS: User[] = [
  { id: "u_ava", name: "Ava Chen", email: "ava@acme.test", role: "manager", team: "enterprise" },
  { id: "u_ben", name: "Ben Ortiz", email: "ben@acme.test", role: "rep", team: "smb" },
];

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/users") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(USERS), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(cleanup);

function renderWidget(overrides: Partial<FieldWidgetProps> = {}) {
  const onChange = vi.fn();
  const props: FieldWidgetProps = {
    value: undefined,
    onChange,
    schema: { type: "string" },
    meta: { label: "Owner", widget: "crm.userSelect" },
    stepId: "assign",
    fieldKey: "ownerId",
    ...overrides,
  };
  render(<UserSelect {...props} />);
  return { onChange };
}

describe("crm.userSelect", () => {
  it("shows the picked user and sets the ID of a newly picked one", async () => {
    const { onChange } = renderWidget({ value: "u_ava" });
    expect(await screen.findByText("Ava Chen")).toBeTruthy();
    expect(screen.getByText("Manager, Enterprise team")).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Owner"), "u_ben");
    expect(onChange).toHaveBeenCalledWith("u_ben");
  });

  it("groups users by team and removes the value with Not set", async () => {
    const { onChange } = renderWidget({ value: "u_ben" });
    const select = await screen.findByLabelText("Owner");
    await screen.findByText("Sales rep, SMB team");
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Enterprise team", "SMB team"]);

    await userEvent.selectOptions(select, "");
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("shows a mapped value and switches back to picking a user", async () => {
    const { onChange } = renderWidget({ value: { $ref: "steps.contact.ownerId" } });
    expect(screen.getByText("steps.contact.ownerId")).toBeTruthy();
    expect(screen.queryByLabelText("Owner")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Pick a user" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("flags an ID that matches no user", async () => {
    renderWidget({ value: "u_gone" });
    expect(await screen.findByText("Unknown user")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Unknown user (u_gone)" })).toBeTruthy();
  });

  it("can't be changed when read-only", async () => {
    renderWidget({ value: "u_ava", readOnly: true });
    await screen.findByText("Manager, Enterprise team");
    expect((screen.getByLabelText("Owner") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
