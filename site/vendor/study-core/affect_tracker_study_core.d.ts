/* tslint:disable */
/* eslint-disable */

/**
 * JSON-only WASM boundary. It deliberately exposes no browser or platform API.
 */
export class WasmStudyAuthorityV1 {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies one strict `StudyActionV1` JSON and returns `ReducerOutcomeV1`.
     */
    applyJson(action_json: string): string;
    /**
     * Creates an authority from a published study and run configuration JSON.
     */
    constructor(study_json: string, configuration_json: string, authority_generation: bigint);
    /**
     * Returns the current strict `RunStateV1` JSON.
     */
    stateJson(): string;
}

/**
 * Returns the canonical lowercase SHA-256 for valid study JSON.
 */
export function protocolHashJsonV1(study_json: string): string;

/**
 * Validates a draft JSON declaration and returns its immutable published form.
 */
export function publishStudyJsonV1(study_json: string): string;

/**
 * Strictly decodes and validates a browser-produced `ResultManifestV1`.
 * Returning normalized JSON supplies one fail-closed contract boundary while
 * keeping storage and download capabilities outside the pure WASM core.
 */
export function validateResultManifestJsonV1(manifest_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmstudyauthorityv1_free: (a: number, b: number) => void;
    readonly protocolHashJsonV1: (a: number, b: number) => [number, number, number, number];
    readonly publishStudyJsonV1: (a: number, b: number) => [number, number, number, number];
    readonly validateResultManifestJsonV1: (a: number, b: number) => [number, number, number, number];
    readonly wasmstudyauthorityv1_applyJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmstudyauthorityv1_new: (a: number, b: number, c: number, d: number, e: bigint) => [number, number, number];
    readonly wasmstudyauthorityv1_stateJson: (a: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
