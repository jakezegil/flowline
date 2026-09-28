/**
 * The default {@link TransformRuntime}: QuickJS compiled to WebAssembly (`quickjs-emscripten`).
 *
 * @module
 */
import type { TransformRuntime } from "@flowkit/core";
import { newQuickJSWASMModule, type QuickJSWASMModule } from "quickjs-emscripten";
import { FatalError } from "../errors";

/** Options of {@link quickjsRuntime}. */
export interface QuickjsRuntimeOptions {
  /** Time limit used when a call passes no `timeoutMs`. Default `1000`. */
  defaultTimeoutMs?: number;
  /** Memory limit used when a call passes no `memoryBytes`. Default 64 MB. */
  defaultMemoryBytes?: number;
  /** @internal The WASM module to create runtimes from (tests use a leak-checking module). */
  module?: () => Promise<Pick<QuickJSWASMModule, "newRuntime">>;
}

/**
 * QuickJS stack limit. It must stay well below the host stack the WASM frames run on, so deep
 * recursion fails with a catchable "stack overflow" instead of overflowing the host.
 */
const MAX_STACK_BYTES = 256 * 1024;
const FILENAME = "transform.js";
const INPUT_GLOBAL = "__flowkitInput";
/**
 * Smallest memory limit applied. Below it QuickJS cannot even allocate its out-of-memory error
 * and throws `null`, which would be indistinguishable from user code throwing `null`.
 */
const MIN_MEMORY_BYTES = 64 * 1024;
/** Maximum size of a transform's JSON result, in UTF-8 bytes. */
const MAX_RESULT_BYTES = 1024 * 1024;

let sharedModule: Promise<QuickJSWASMModule> | undefined;
const defaultModule = () => {
  sharedModule ??= newQuickJSWASMModule();
  return sharedModule;
};

/**
 * Wraps user code. Everything before the user's code sits on line 1, so line numbers in errors
 * match the user's code.
 */
function wrap(code: string): string {
  return (
    `const input = JSON.parse(globalThis.${INPUT_GLOBAL}); delete globalThis.${INPUT_GLOBAL}; ` +
    `const { trigger, steps, loop } = input; ` +
    `JSON.stringify((function () { "use strict"; ${code}\n})());`
  );
}

function describeError(dumped: unknown): string {
  if (typeof dumped !== "object" || dumped === null) return `Transform threw ${String(dumped)}`;
  const e = dumped as { name?: unknown; message?: unknown; stack?: unknown };
  const head = typeof e.name === "string" && e.name !== "" ? `${e.name}: ` : "";
  const message = typeof e.message === "string" ? e.message : String(dumped);
  const line = typeof e.stack === "string" ? /transform\.js:(\d+)/.exec(e.stack)?.[1] : undefined;
  return `${head}${message}${line ? ` (line ${line})` : ""}`;
}

/** Keys dropped from transform results, so they cannot smuggle prototype-pollution payloads. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeReviver(key: string, value: unknown): unknown {
  return UNSAFE_KEYS.has(key) ? undefined : value;
}

function outOfMemory(memoryBytes: number): FatalError {
  return new FatalError(`Transform ran out of memory (limit ${memoryBytes} bytes)`);
}

/** Thrown inside {@link evaluate} when the VM ran out of memory outside user code. */
class VmOutOfMemory extends Error {}

/** Runs `code` in a fresh runtime and context, disposing both (and every handle) afterwards. */
function evaluate(
  module: Pick<QuickJSWASMModule, "newRuntime">,
  code: string,
  inputJson: string,
  timeoutMs: number,
  memoryBytes: number,
): unknown {
  const runtime = module.newRuntime();
  try {
    runtime.setMaxStackSize(MAX_STACK_BYTES);
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) timedOut = true;
      return timedOut;
    });
    // The context is created before the limit applies: QuickJS cannot recover from failing to
    // build its own intrinsics.
    const vm = runtime.newContext();
    try {
      runtime.setMemoryLimit(memoryBytes);
      const input = vm.newString(inputJson);
      try {
        vm.setProp(vm.global, INPUT_GLOBAL, input);
      } catch {
        throw new VmOutOfMemory();
      } finally {
        input.dispose();
      }
      const result = vm.evalCode(wrap(code), FILENAME);
      if (result.error) {
        let dumped: unknown;
        try {
          dumped = vm.dump(result.error);
        } finally {
          result.error.dispose();
        }
        if (timedOut) throw new FatalError(`Transform timed out after ${timeoutMs}ms`);
        const message = describeError(dumped);
        if (/out of memory/i.test(message)) throw outOfMemory(memoryBytes);
        throw new FatalError(message);
      }
      let out: string | undefined;
      try {
        out = vm.typeof(result.value) === "string" ? vm.getString(result.value) : undefined;
      } finally {
        result.value.dispose();
      }
      if (out === undefined) return undefined;
      // Each UTF-16 code unit encodes to at most 3 UTF-8 bytes; count exactly only when close.
      if (out.length * 3 > MAX_RESULT_BYTES && utf8Length(out) > MAX_RESULT_BYTES) {
        throw new FatalError("Transform result too large (max 1 MB)");
      }
      try {
        return JSON.parse(out, safeReviver) as unknown;
      } catch {
        throw new FatalError("Transform result is not valid JSON");
      }
    } finally {
      // Freeing may allocate (finalizers, GC bookkeeping); never fail it on the user's limit.
      runtime.setMemoryLimit(-1);
      vm.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Create a QuickJS-backed {@link TransformRuntime}. Every call gets a fresh runtime and context,
 * disposed afterwards, with the call's memory limit (at least 64 KB) and a deadline enforced by an interrupt
 * handler. The code runs as the body of a function (so it `return`s its result) with the scope
 * available as `input` and destructured as `trigger`, `steps` and `loop`; the scope goes in and
 * the result comes out as JSON. There is no `fetch`, `require`, `process`, timers or other host
 * API. Evaluation is synchronous: a call blocks the event loop for up to its time limit.
 *
 * Every failure rejects with a `FatalError`: user errors (thrown, syntax, reference) carry the
 * JavaScript message and line; timeouts, memory and stack exhaustion, results over 1 MB of JSON
 * and unserializable results have fixed messages; anything else is "Transform failed (internal
 * error)" with the original error as `cause`. Result keys `__proto__`, `constructor` and
 * `prototype` are dropped.
 *
 * @example
 * ```ts
 * const engine = createEngine({ registry, storage, transform: quickjsRuntime() });
 * ```
 */
export function quickjsRuntime(opts: QuickjsRuntimeOptions = {}): TransformRuntime {
  const loadModule = opts.module ?? defaultModule;
  return {
    async run(code, scope, limits) {
      const timeoutMs = limits?.timeoutMs ?? opts.defaultTimeoutMs ?? 1000;
      const memoryBytes = Math.max(
        limits?.memoryBytes ?? opts.defaultMemoryBytes ?? 64 * 1024 * 1024,
        MIN_MEMORY_BYTES,
      );
      let inputJson: string;
      try {
        inputJson = JSON.stringify(scope ?? null);
      } catch (err) {
        throw new FatalError(`Transform input is not serializable: ${(err as Error).message}`);
      }
      const module = await loadModule();
      try {
        return evaluate(module, code, inputJson, timeoutMs, memoryBytes);
      } catch (err) {
        if (err instanceof FatalError) throw err;
        if (err instanceof VmOutOfMemory) throw outOfMemory(memoryBytes);
        // A host-level failure (WASM trap, host stack overflow) may leave the module unusable:
        // start the next call from a fresh one. Its details stay in `cause`, for logs only.
        if (!opts.module) sharedModule = undefined;
        throw new FatalError("Transform failed (internal error)", { cause: err });
      }
    },
  };
}
