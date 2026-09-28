/**
 * The default {@link TransformRuntime}: QuickJS compiled to WebAssembly (`quickjs-emscripten`).
 *
 * @module
 */
import type { TransformRuntime } from "@flowlinejs/core";
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { FatalError } from "../errors";

type Module = Pick<QuickJSWASMModule, "newRuntime">;

/** Options of {@link quickjsRuntime}. */
export interface QuickjsRuntimeOptions {
  /** Time limit used when a call passes no `timeoutMs`. Default `1000`. */
  defaultTimeoutMs?: number;
  /** Memory limit used when a call passes no `memoryBytes`. Default 64 MB. */
  defaultMemoryBytes?: number;
  /**
   * @internal Creates the WASM module to create runtimes from (tests use a leak-checking module).
   * Called once, and again after a host-level failure left the previous module unusable.
   */
  module?: () => Promise<Module>;
}

/**
 * QuickJS stack limit. It must stay well below the host stack the WASM frames run on, so deep
 * recursion fails with a catchable "stack overflow" instead of overflowing the host.
 */
const MAX_STACK_BYTES = 256 * 1024;
const FILENAME = "transform.js";
const INPUT_GLOBAL = "__flowlineInput";
/**
 * Smallest memory limit applied. Below it QuickJS cannot even allocate its out-of-memory error
 * and throws `null`, which would be indistinguishable from user code throwing `null`.
 */
const MIN_MEMORY_BYTES = 64 * 1024;
/** Maximum size of a transform's JSON result, in UTF-8 bytes. */
const MAX_RESULT_BYTES = 1024 * 1024;
/**
 * Maximum nesting depth of the input and the result. QuickJS parses deeper input (and the host
 * parses deeper results) only by recursing close to its stack limit.
 */
const MAX_DEPTH = 1000;
const STACK_MESSAGE = "Transform exceeded the stack limit (recursion or data nested too deeply)";

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

/** Whether a JSON text nests objects and arrays more than `max` levels deep (no recursion). */
function nestedDeeperThan(json: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > max) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
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

/** What {@link evaluate} produced, and whether the module must be discarded afterwards. */
type Outcome = ({ ok: true; value: unknown } | { ok: false; error: unknown }) & {
  poisoned: boolean;
};

/**
 * Engine intrinsics captured before user code runs, so errors can be classified by their actual
 * prototype rather than by a `name` or `message` that user code can set.
 */
interface Intrinsics {
  getPrototypeOf: QuickJSHandle;
  internalErrorPrototype: QuickJSHandle;
}

function captureIntrinsics(vm: QuickJSContext): Intrinsics {
  const object = vm.getProp(vm.global, "Object");
  const internalError = vm.getProp(vm.global, "InternalError");
  try {
    return {
      getPrototypeOf: vm.getProp(object, "getPrototypeOf"),
      internalErrorPrototype: vm.getProp(internalError, "prototype"),
    };
  } finally {
    object.dispose();
    internalError.dispose();
  }
}

/** Whether `error` is one of the engine's own `InternalError`s (out of memory, stack overflow). */
function isEngineError(vm: QuickJSContext, intrinsics: Intrinsics, error: QuickJSHandle): boolean {
  if (vm.typeof(error) !== "object") return false;
  const proto = vm.callFunction(intrinsics.getPrototypeOf, vm.undefined, error);
  if (proto.error) {
    proto.error.dispose();
    return false;
  }
  try {
    return vm.sameValue(proto.value, intrinsics.internalErrorPrototype);
  } finally {
    proto.value.dispose();
  }
}

/** Turns a thrown VM value into the `FatalError` the caller sees. */
function userFacingError(
  vm: QuickJSContext,
  intrinsics: Intrinsics,
  error: QuickJSHandle,
  memoryBytes: number,
): FatalError {
  const engine = isEngineError(vm, intrinsics, error);
  const dumped: unknown = vm.dump(error);
  if (engine) {
    const message = (dumped as { message?: unknown } | null)?.message;
    if (message === "out of memory") return outOfMemory(memoryBytes);
    if (message === "stack overflow") return new FatalError(STACK_MESSAGE);
  }
  return new FatalError(describeError(dumped));
}

/** Evaluates the wrapped code in `vm` and returns the parsed result. */
function evaluateIn(
  vm: QuickJSContext,
  code: string,
  inputJson: string,
  memoryBytes: number,
  timedOut: () => boolean,
  timeoutMs: number,
): unknown {
  const intrinsics = captureIntrinsics(vm);
  try {
    vm.runtime.setMemoryLimit(memoryBytes);
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
      try {
        if (timedOut()) throw new FatalError(`Transform timed out after ${timeoutMs}ms`);
        throw userFacingError(vm, intrinsics, result.error, memoryBytes);
      } finally {
        result.error.dispose();
      }
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
    if (nestedDeeperThan(out, MAX_DEPTH)) {
      throw new FatalError(`Transform result is nested too deeply (max ${MAX_DEPTH} levels)`);
    }
    try {
      return JSON.parse(out, safeReviver) as unknown;
    } catch {
      throw new FatalError("Transform result is not valid JSON");
    }
  } finally {
    intrinsics.getPrototypeOf.dispose();
    intrinsics.internalErrorPrototype.dispose();
  }
}

/**
 * Runs `code` in a fresh runtime and context, disposing both (and every handle) afterwards.
 * Never throws: failures come back in the outcome. `poisoned` is set when freeing failed (QuickJS
 * leaks objects when some native functions overflow its stack, and then aborts on dispose), so
 * the module's memory can no longer be trusted.
 */
function evaluate(
  module: Module,
  code: string,
  inputJson: string,
  timeoutMs: number,
  memoryBytes: number,
): Outcome {
  let runtime: ReturnType<Module["newRuntime"]>;
  try {
    runtime = module.newRuntime();
  } catch (error) {
    return { ok: false, error, poisoned: true };
  }
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
  let vm: QuickJSContext | undefined;
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
    vm = runtime.newContext();
    const value = evaluateIn(vm, code, inputJson, memoryBytes, () => timedOut, timeoutMs);
    outcome = { ok: true, value };
  } catch (error) {
    if (isHostStackOverflow(error)) {
      // The host stack ran out inside QuickJS's C code (its frames are larger before the WASM is
      // optimized), leaving the runtime half-unwound: never touch this module again.
      return { ok: false, error: new FatalError(STACK_MESSAGE, { cause: error }), poisoned: true };
    }
    outcome = { ok: false, error };
  }
  try {
    // Freeing may allocate (finalizers, GC bookkeeping); never fail it on the user's limit.
    runtime.setMemoryLimit(-1);
    vm?.dispose();
    runtime.dispose();
    return { ...outcome, poisoned: false };
  } catch {
    return { ...outcome, poisoned: true };
  }
}

/** A host (V8) stack overflow. User code's errors are VM values, never host exceptions. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && error.message === "Maximum call stack size exceeded";
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Create a QuickJS-backed {@link TransformRuntime}. Every call gets a fresh runtime and context,
 * disposed afterwards, with the call's memory limit (at least 64 KB) and a deadline enforced by
 * an interrupt handler. The code runs as the body of a function (so it `return`s its result)
 * with the scope available as `input` and destructured as `trigger`, `steps` and `loop`; the
 * scope goes in and the result comes out as JSON. There is no `fetch`, `require`, `process`,
 * timers or other host API. Evaluation is synchronous: a call blocks the event loop for up to its
 * time limit.
 *
 * Every failure rejects with a `FatalError`: user errors (thrown, syntax, reference) carry the
 * JavaScript message and line; timeouts, memory and stack exhaustion, input or results nested
 * more than 1000 levels deep, results over 1 MB of JSON and unserializable results have fixed
 * messages; anything else is "Transform failed (internal error)" with the original error as
 * `cause`. Memory and stack exhaustion are recognised by the engine's own `InternalError`
 * prototype, so a user `throw new Error("out of memory")` stays a user error. When QuickJS fails
 * to free a runtime (it leaks objects when some native functions such as `JSON.stringify`
 * overflow its stack), the WASM module is discarded and a fresh one is used for the next call.
 *
 * Result keys `__proto__`, `constructor` and `prototype` are dropped at every depth.
 *
 * @example
 * ```ts
 * const engine = createEngine({ registry, storage, transform: quickjsRuntime() });
 * ```
 */
export function quickjsRuntime(opts: QuickjsRuntimeOptions = {}): TransformRuntime {
  const factory = opts.module;
  let own: Promise<Module> | undefined;
  const loadModule = (): Promise<Module> => {
    if (!factory) return defaultModule();
    own ??= factory().catch((err: unknown) => {
      own = undefined;
      throw err;
    });
    return own;
  };
  const discardModule = () => {
    if (factory) own = undefined;
    else sharedModule = undefined;
  };

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
      if (nestedDeeperThan(inputJson, MAX_DEPTH)) {
        throw new FatalError(`Transform input is nested too deeply (max ${MAX_DEPTH} levels)`);
      }
      const outcome = evaluate(await loadModule(), code, inputJson, timeoutMs, memoryBytes);
      // A module that failed to free a runtime (or trapped) may be corrupt or leaking: start the
      // next call from a fresh one.
      if (outcome.poisoned) discardModule();
      if (outcome.ok) return outcome.value;
      const err = outcome.error;
      if (err instanceof FatalError) throw err;
      if (err instanceof VmOutOfMemory) throw outOfMemory(memoryBytes);
      // A host-level failure (WASM trap, host stack overflow). Its details stay in `cause`, for
      // logs only.
      discardModule();
      throw new FatalError("Transform failed (internal error)", { cause: err });
    },
  };
}
