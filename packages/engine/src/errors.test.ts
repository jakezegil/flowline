import { describe, expect, it } from "vitest";
import { FatalError, FlowlineStorageError, RetryableError } from "./errors";

describe("errors", () => {
  it("RetryableError is an Error with its name", () => {
    const e = new RetryableError("try again");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RetryableError");
    expect(e.message).toBe("try again");
  });

  it("FatalError carries an optional code and cause", () => {
    const cause = new Error("root");
    const e = new FatalError("nope", { code: "E_BAD", cause });
    expect(e.name).toBe("FatalError");
    expect(e.code).toBe("E_BAD");
    expect(e.cause).toBe(cause);
    expect(new FatalError("x").code).toBeUndefined();
  });

  it("FlowlineStorageError is an Error with its name", () => {
    const e = new FlowlineStorageError("conflict");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("FlowlineStorageError");
  });
});
