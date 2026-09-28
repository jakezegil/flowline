// Stub for the README's conformance snippet.
import type { StorageAdapter } from "@flowlinejs/engine";

export declare function createMyStorage(): Promise<StorageAdapter & { close(): Promise<void> }>;
