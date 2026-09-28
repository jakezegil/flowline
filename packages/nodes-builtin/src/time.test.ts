import { FatalError, type NodeContext, RetryableError } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { fakeContext, NOW } from "../test/fake-context";
import { delayNode, MAX_DURATION_MS, parseDuration, waitForCallbackNode } from "./time";

const SEC = 1000;
const DAY = 86_400 * SEC;

describe("parseDuration", () => {
  it.each([
    ["30s", 30 * SEC],
    ["5m", 5 * 60 * SEC],
    ["2h", 2 * 3600 * SEC],
    ["3d", 3 * DAY],
    ["1d", DAY],
  ])("%s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "0s", "5", "d", "1.5h", "2 days", "-1m", "1w", " 5m"])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeUndefined();
  });
});

describe("core.delay", () => {
  const parse = (config: unknown) => delayNode.input.safeParse(config);

  it("needs exactly one of duration and until", () => {
    expect(parse({ duration: "5m" }).success).toBe(true);
    expect(parse({ until: "2026-02-01T09:00:00Z" }).success).toBe(true);
    const neither = parse({});
    expect(neither.error?.issues[0]?.message).toBe(
      "Set how long to wait, or the date and time to wait until",
    );
    const both = parse({ duration: "5m", until: "2026-02-01T09:00:00Z" });
    expect(both.error?.issues[0]?.message).toBe(
      "Set how long to wait or the date and time to wait until, not both",
    );
  });

  it("explains a malformed duration or date", () => {
    expect(parse({ duration: "5 minutes" }).error?.issues[0]?.message).toBe(
      "Use a whole number and a unit: 30s, 5m, 2h or 3d",
    );
    expect(parse({ until: "next tuesday" }).success).toBe(false);
  });

  it("caps durations at 365 days", () => {
    expect(parse({ duration: "365d" }).success).toBe(true);
    expect(parse({ duration: "8760h" }).success).toBe(true);
    expect(parse({ duration: "366d" }).error?.issues[0]?.message).toBe(
      "Durations can be at most 365d",
    );
    expect(parse({ duration: "999999999999d" }).error?.issues[0]?.message).toBe(
      "Durations can be at most 365d",
    );
    expect(MAX_DURATION_MS).toBe(365 * DAY);
  });

  it("fails fatally on a duration that skipped validation", async () => {
    for (const [duration, message] of [
      ["2 days", "Use a whole number and a unit: 30s, 5m, 2h or 3d"],
      ["400d", "Durations can be at most 365d"],
    ]) {
      const run = async () => delayNode.run({ input: { duration }, ctx: fakeContext() });
      await expect(run()).rejects.toThrow(FatalError);
      await expect(run()).rejects.toThrow(message);
    }
  });

  it("suspends until now + duration", async () => {
    const input = delayNode.input.parse({ duration: "2h" });
    expect(await delayNode.run({ input, ctx: fakeContext() })).toMatchObject({
      kind: "suspend",
      until: NOW + 2 * 3600 * SEC,
    });
  });

  it("suspends until the given time", async () => {
    const input = delayNode.input.parse({ until: "2026-01-03T00:00:00+02:00" });
    expect(await delayNode.run({ input, ctx: fakeContext() })).toMatchObject({
      kind: "suspend",
      until: Date.parse("2026-01-02T22:00:00Z"),
    });
  });

  it("continues at once when the time has already passed", async () => {
    const input = delayNode.input.parse({ until: "2025-12-31T00:00:00Z" });
    expect(await delayNode.run({ input, ctx: fakeContext() })).toEqual({
      resumedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns the resume time when the timer fires", async () => {
    const input = delayNode.input.parse({ duration: "30s" });
    const ctx = fakeContext({ resume: { kind: "timer" }, now: () => NOW + 30 * SEC });
    expect(await delayNode.run({ input, ctx })).toEqual({ resumedAt: "2026-01-01T00:00:30.000Z" });
  });
});

describe("core.waitForCallback", () => {
  it("defaults the timeout to 7 days", () => {
    expect(waitForCallbackNode.input.parse({})).toEqual({ timeout: "7d" });
  });

  it("creates a callback and suspends on it", async () => {
    const seen: number[] = [];
    const ctx = fakeContext({
      async callback({ timeoutMs }) {
        seen.push(timeoutMs);
        return { token: "tok", resumeUrl: "u", expiresAt: NOW + timeoutMs };
      },
    });
    const result = await waitForCallbackNode.run({
      input: waitForCallbackNode.input.parse({ timeout: "2h" }),
      ctx,
    });
    expect(seen).toEqual([2 * 3600 * SEC]);
    expect(result).toMatchObject({ kind: "suspend", callback: { token: "tok" } });
  });

  it("caps the timeout at 365 days", () => {
    expect(waitForCallbackNode.input.safeParse({ timeout: "366d" }).error?.issues[0]?.message).toBe(
      "Durations can be at most 365d",
    );
  });

  it("fails fatally on a timeout that skipped validation", async () => {
    const run = async () =>
      waitForCallbackNode.run({ input: { timeout: "soon" }, ctx: fakeContext() });
    await expect(run()).rejects.toThrow(FatalError);
    await expect(run()).rejects.toThrow("Use a whole number and a unit: 30s, 5m, 2h or 3d");
  });

  it("takes Resumed with the callback body", async () => {
    const ctx = fakeContext({ resume: { kind: "callback", body: { approved: true } } });
    const input = waitForCallbackNode.input.parse({});
    expect(await waitForCallbackNode.run({ input, ctx })).toMatchObject({
      kind: "branch",
      branch: "resumed",
      output: { body: { approved: true }, timedOut: false },
    });
  });

  it("uses null for an empty callback body", async () => {
    const ctx = fakeContext({ resume: { kind: "callback", body: undefined } });
    const input = waitForCallbackNode.input.parse({});
    expect(await waitForCallbackNode.run({ input, ctx })).toMatchObject({
      output: { body: null, timedOut: false },
    });
  });

  it("takes Timed out when the callback expires", async () => {
    const ctx = fakeContext({ resume: { kind: "timeout" } });
    const input = waitForCallbackNode.input.parse({});
    expect(await waitForCallbackNode.run({ input, ctx })).toMatchObject({
      kind: "branch",
      branch: "timeout",
      output: { body: null, timedOut: true },
    });
  });

  describe("notify", () => {
    type Call = { url: string; init: Parameters<NodeContext["http"]["fetch"]>[1] };
    const notifying = (respond: () => Promise<Response>) => {
      const calls: Call[] = [];
      const ctx = fakeContext({
        runId: "run-7",
        idempotencyKey: "idem-1",
        http: {
          async fetch(url, init) {
            calls.push({ url, init });
            return respond();
          },
        },
      });
      return { calls, ctx };
    };
    const input = () =>
      waitForCallbackNode.input.parse({
        timeout: "1d",
        notify: { url: "https://hooks.example/approvals" },
      });

    it("accepts only an http(s) URL", () => {
      expect(waitForCallbackNode.input.safeParse({ notify: { url: "ftp://x/y" } }).success).toBe(
        false,
      );
      expect(waitForCallbackNode.input.safeParse({ notify: { url: "nope" } }).success).toBe(false);
      expect(waitForCallbackNode.input.parse({})).not.toHaveProperty("notify");
    });

    it("POSTs the resume URL, expiry and run ID once, with the idempotency key", async () => {
      const { calls, ctx } = notifying(async () => new Response(null, { status: 204 }));
      const result = await waitForCallbackNode.run({ input: input(), ctx });
      expect(result).toMatchObject({ kind: "suspend", callback: { token: "tok" } });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.url).toBe("https://hooks.example/approvals");
      expect(call?.init?.method).toBe("POST");
      const headers = new Headers(call?.init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("idempotency-key")).toBe("idem-1");
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        resumeUrl: "https://x/flowkit/resume/tok",
        expiresAt: NOW + DAY,
        runId: "run-7",
      });
    });

    it.each([
      ["a 5xx response", async () => new Response("down", { status: 503 })],
      ["a 4xx response", async () => new Response("no", { status: 404 })],
      [
        "a network error",
        async (): Promise<Response> => {
          throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
        },
      ],
    ])("fails retryably on %s, without the token in the message", async (_, respond) => {
      const { ctx } = notifying(respond);
      const err = await Promise.resolve()
        .then(() => waitForCallbackNode.run({ input: input(), ctx }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as Error).message).toMatch(/^Notify request failed/);
      expect((err as Error).message).not.toContain("tok");
    });

    it("keeps a fatal error from the network guard fatal", async () => {
      const { ctx } = notifying(async () => {
        throw new FatalError("blocked private network address");
      });
      await expect(waitForCallbackNode.run({ input: input(), ctx })).rejects.toThrow(FatalError);
    });

    it("doesn't notify again when resumed", async () => {
      for (const resume of [{ kind: "callback", body: 1 }, { kind: "timeout" }] as const) {
        const { calls, ctx } = notifying(async () => new Response(null, { status: 204 }));
        ctx.resume = resume;
        await waitForCallbackNode.run({ input: input(), ctx });
        expect(calls).toEqual([]);
      }
    });
  });
});
