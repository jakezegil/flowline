// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RunBadge } from "./ui";

afterEach(cleanup);

function badge(status: string, stoppedAt?: string) {
  render(
    <MemoryRouter>
      <RunBadge runId="r1" status={status} stoppedAt={stoppedAt} />
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: /./ });
  const el = link.querySelector(".badge") as HTMLElement;
  cleanup();
  return { text: el.textContent, tone: el.dataset.tone };
}

describe("RunBadge", () => {
  it("labels every run status", () => {
    expect(badge("queued")).toEqual({ text: "Queued", tone: "neutral" });
    expect(badge("running")).toEqual({ text: "Running", tone: "info" });
    expect(badge("waiting")).toEqual({ text: "Waiting", tone: "warning" });
    expect(badge("completed")).toEqual({ text: "Completed", tone: "success" });
    expect(badge("failed")).toEqual({ text: "Failed", tone: "danger" });
    expect(badge("cancelled")).toEqual({ text: "Cancelled", tone: "neutral" });
  });

  it("reads Stopped for a run a Stop step ended, as the run viewer does", () => {
    expect(badge("completed", "cond/else/stop")).toEqual({ text: "Stopped", tone: "neutral" });
  });
});
