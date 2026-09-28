import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { setupDom } from "../../test/dom";
import { loopEntry, samples, scope } from "../../test/picker-fixtures";
import { DataPicker } from "./data-picker";

beforeAll(setupDom);
afterEach(cleanup);

const rowNames = () =>
  screen
    .getAllByRole("treeitem")
    .map((r) => r.querySelector(".fk-dp__name, .fk-dp__section-name")?.textContent);

describe("DataPicker", () => {
  test("lists the trigger and upstream steps, loop first, then trigger, then nearest step first", () => {
    render(<DataPicker scope={[...scope, loopEntry]} samples={samples} onPick={() => {}} />);
    const sections = screen
      .getAllByRole("treeitem")
      .filter((r) => r.getAttribute("aria-level") === "1")
      .map((r) => r.querySelector(".fk-dp__section-name")?.textContent);
    expect(sections).toEqual(["For each tag", "Deal updated", "Fetch orders", "Load contact"]);
  });

  test("shows fields with types and sample values", () => {
    render(<DataPicker scope={scope} samples={samples} onPick={() => {}} />);
    const trigger = screen.getAllByRole("treeitem").find((r) => r.textContent?.startsWith("name"));
    expect(trigger?.textContent).toContain("Ada");
    expect(trigger?.textContent).toContain("string");
  });

  test("picking a field reports its ref path and type", async () => {
    const onPick = vi.fn();
    render(<DataPicker scope={scope} samples={samples} onPick={onPick} />);
    const amount = screen.getAllByRole("treeitem").find((r) => r.textContent?.startsWith("amount"));
    fireEvent.click(amount as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("trigger.amount", "number");
  });

  test("search filters to matching fields and keeps their sections", async () => {
    render(<DataPicker scope={scope} samples={samples} onPick={() => {}} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Search data" }), "domain");
    expect(rowNames()).toEqual(["Load contact", "company", "domain"]);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "nothing like this");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByText("No data matches “nothing like this”.")).toBeTruthy();
  });

  test("a step without a schema falls back to its sample's shape", () => {
    render(<DataPicker scope={scope} samples={samples} onPick={() => {}} />);
    // The nearest step (Fetch orders) starts open, earlier ones closed.
    const load = screen
      .getAllByRole("treeitem")
      .find((r) => r.textContent?.includes("Load contact"));
    expect(load?.getAttribute("aria-expanded")).toBe("false");
    expect(rowNames()).toContain("status");
    expect(rowNames()).toContain("body");
  });

  const openLoad = () => {
    const load = screen
      .getAllByRole("treeitem")
      .find((r) => r.textContent?.includes("Load contact"));
    fireEvent.click(load as HTMLElement);
  };

  test("lists offer [0] and insert as a whole", () => {
    const onPick = vi.fn();
    render(<DataPicker scope={scope} samples={samples} onPick={onPick} />);
    openLoad();
    const tags = screen.getAllByRole("treeitem").find((r) => r.textContent?.startsWith("tags"));
    if (!tags) throw new Error("no tags row");
    fireEvent.click(within(tags).getByTitle("Insert all of tags"));
    expect(onPick).toHaveBeenLastCalledWith("steps.load.tags", "string[]");
    fireEvent.click(tags);
    const first = screen
      .getAllByRole("treeitem")
      .find((r) => r.textContent?.includes("First item"));
    fireEvent.click(first as HTMLElement);
    expect(onPick).toHaveBeenLastCalledWith("steps.load.tags[0]", "string");
  });

  test("works from the keyboard: arrows move, Right expands, Enter picks", async () => {
    const onPick = vi.fn();
    render(<DataPicker scope={scope} samples={samples} onPick={onPick} />);
    const search = screen.getByRole("combobox");
    search.focus();
    // Rows: Deal updated, name, amount, Fetch orders, status, body, Load contact
    await userEvent.keyboard("{ArrowDown>6/}");
    const active = () =>
      screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-selected") === "true");
    expect(active()?.textContent).toContain("Load contact");
    expect(search.getAttribute("aria-activedescendant")).toBe(active()?.id);
    await userEvent.keyboard("{ArrowRight}");
    expect(rowNames()).toContain("email");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("steps.load.email", "string");
    await userEvent.keyboard("{ArrowUp}{Shift>}{Enter}{/Shift}");
    expect(onPick).toHaveBeenLastCalledWith("steps.load", "object");
    await userEvent.keyboard("{ArrowLeft}");
    expect(rowNames()).not.toContain("email");
  });

  test("filterType hides fields that can't go into the field", () => {
    render(
      <DataPicker
        scope={scope}
        samples={samples}
        onPick={() => {}}
        filterType={{ type: "number" }}
      />,
    );
    const names = rowNames();
    expect(names).toContain("amount");
    expect(names).not.toContain("name");
    expect(names).not.toContain("email");
  });

  test("an empty scope says where data comes from", () => {
    render(<DataPicker scope={[]} samples={{}} onPick={() => {}} />);
    expect(
      screen.getByText("No data yet — add a step above or configure the trigger."),
    ).toBeTruthy();
  });
});
