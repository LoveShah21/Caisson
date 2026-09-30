// The published package declarations reference browser-only WebAssembly globals
// that TypeScript 7 does not include in this Node project. This is the small
// Node-facing surface Caisson uses from the pinned runtime.
declare module "@open-policy-agent/opa-wasm" {
  export class LoadedPolicy {
    evaluate(input: unknown): unknown;
  }

  export function loadPolicy(wasm: Uint8Array): Promise<LoadedPolicy>;
}
