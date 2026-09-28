// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unreachableMessage, useQuery } from "./api";

afterEach(cleanup);

describe("unreachableMessage", () => {
  it("names the address the dev server proxies to, and no port when it doesn't know it", () => {
    expect(unreachableMessage("http://localhost:8911")).toBe(
      "Can't reach the CRM server. Is it running at http://localhost:8911?",
    );
    expect(unreachableMessage(undefined)).toBe("Can't reach the CRM server. Is it running?");
  });
});

describe("useQuery", () => {
  it("refetches when the window regains focus", async () => {
    let n = 0;
    const load = vi.fn(async () => ++n);
    function Probe() {
      const q = useQuery("approvals", load);
      return <span>count {q.data ?? "-"}</span>;
    }
    render(<Probe />);
    expect(await screen.findByText("count 1")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("count 2")).toBeTruthy();
  });
});
