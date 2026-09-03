function wasmModulePath() {
  return document.querySelector("#study-app")?.dataset.studySurface === "desktop"
    ? "./study-core/affect_tracker_study_core.js"
    : "./vendor/study-core/affect_tracker_study_core.js";
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalStudyJson(value) {
  const protocol = globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  delete protocol.protocolHash;
  return JSON.stringify(canonicalValue(protocol));
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fallbackValidation(study) {
  const errors = [];
  const add = (path, message) => errors.push({ code: "browserPrecheck", path, message });
  if (study?.schema !== "affect-tracker-study") add("schema", "Expected affect-tracker-study.");
  if (study?.version !== 1) add("version", "Only study version 1 is supported.");
  if (typeof study?.studyId !== "string" || !study.studyId.trim()) add("studyId", "A study ID is required.");
  if (typeof study?.title !== "string" || !study.title.trim()) add("title", "A title is required.");
  if (!Array.isArray(study?.sections) || study.sections.length === 0) add("sections", "Add at least one section.");
  const blockIds = new Set();
  const questionnaireIds = new Set((study?.questionnaires ?? []).map(({ questionnaireId }) => questionnaireId));
  for (const [sectionIndex, section] of (study?.sections ?? []).entries()) {
    if (!Array.isArray(section.trials) || section.trials.length === 0) {
      add(`sections[${sectionIndex}].trials`, "Add at least one trial.");
      continue;
    }
    for (const [trialIndex, trial] of section.trials.entries()) {
      for (const [blockIndex, block] of (trial.blocks ?? []).entries()) {
        const path = `sections[${sectionIndex}].trials[${trialIndex}].blocks[${blockIndex}]`;
        if (blockIds.has(block.blockId)) add(`${path}.blockId`, "Block IDs must be unique.");
        blockIds.add(block.blockId);
        if (block.type === "questionnaire" && !questionnaireIds.has(block.questionnaireId)) {
          add(`${path}.questionnaireId`, "The referenced questionnaire does not exist.");
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function normalizeWasmResult(result) {
  if (typeof result === "string") return JSON.parse(result);
  return result;
}

export function normalizeProtocolHashResult(result) {
  if (typeof result !== "string" || !/^[a-f0-9]{64}$/u.test(result)) {
    throw new TypeError("The shared study core returned an invalid protocol hash.");
  }
  return result;
}

function nativeError(error) {
  if (error && typeof error === "object") {
    return {
      code: typeof error.code === "string" ? error.code : "nativeStudyAuthority",
      path: "study",
      message: typeof error.message === "string" ? error.message : String(error),
    };
  }
  return { code: "nativeStudyAuthority", path: "study", message: String(error) };
}

export function createNativeStudyCore(invoke) {
  if (typeof invoke !== "function") throw new TypeError("A Tauri invoke adapter is required.");

  let activeAuthority;

  const publish = (study) => invoke("publish_study_json", {
    studyJson: JSON.stringify(study),
  });

  const core = {
    implementation: "native-rust",
    canRun: true,
    async hash(study) {
      const validation = await invoke("validate_study_json", {
        studyJson: JSON.stringify(study),
      });
      return validation.protocolHash;
    },
    async validate(study) {
      try {
        const result = await invoke("validate_study_json", {
          studyJson: JSON.stringify(study),
        });
        return { valid: true, errors: [], ...result };
      } catch (error) {
        return { valid: false, errors: [nativeError(error)] };
      }
    },
    publish,
    async createAuthority(study, configuration) {
      const published = await publish(study);
      let cachedState = await invoke("prepare_study_run", {
        studyId: published.studyId,
        studyRevision: published.revision,
        configuration,
        authorityGeneration: null,
      });
      const listeners = new Set();
      const applyOutcome = (action, outcome, source) => {
        const nextState = outcome?.state;
        if (!nextState
          || nextState.runId !== cachedState.runId
          || nextState.authorityGeneration !== cachedState.authorityGeneration
          || !Number.isSafeInteger(nextState.revision)) {
          return false;
        }
        // A remote action can advance the Rust authority while an earlier local
        // invoke is still returning. That accepted local outcome must still be
        // returned so BrowserStudySession can commit its lower-sequence events;
        // it simply must not regress the adapter's newest observable state.
        if (nextState.revision <= cachedState.revision) return source === "local";
        cachedState = nextState;
        const detail = Object.freeze({ action, outcome, source });
        for (const listener of listeners) listener(detail);
        return true;
      };
      const authority = Object.freeze({
        stateJson() {
          return JSON.stringify(cachedState);
        },
        async applyJson(actionJson) {
          const action = JSON.parse(actionJson);
          const outcome = await invoke("apply_study_action", {
            action,
          });
          if (!applyOutcome(action, outcome, "local")) {
            throw new Error("The native authority returned an outcome for a different or stale run.");
          }
          return JSON.stringify(outcome);
        },
        acceptExternalOutcome(action, outcome) {
          return applyOutcome(action, outcome, "external");
        },
        subscribe(listener) {
          if (typeof listener !== "function") throw new TypeError("A native authority listener must be a function.");
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
      activeAuthority = authority;
      return authority;
    },
    acceptExternalOutcome(action, outcome) {
      return activeAuthority?.acceptExternalOutcome(action, outcome) ?? false;
    },
  };
  return Object.freeze(core);
}

function wasmFunction(module, ...names) {
  return names.map((name) => module[name]).find((candidate) => typeof candidate === "function");
}

export async function loadStudyCore() {
  const desktopSurface = document.querySelector("#study-app")?.dataset.studySurface === "desktop";
  if (desktopSurface && globalThis.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return createNativeStudyCore(invoke);
  }

  let module;
  let loadError;
  try {
    const moduleUrl = new URL(wasmModulePath(), document.baseURI).href;
    module = await import(/* @vite-ignore */ moduleUrl);
    if (typeof module.default === "function") await module.default();
  } catch (error) {
    loadError = error;
  }

  const wasmHash = module && wasmFunction(module, "protocolHashJsonV1", "protocol_hash_json_v1");
  const wasmValidate = module && wasmFunction(module, "validateStudyJsonV1", "validate_study_json_v1");
  const wasmPublish = module && wasmFunction(module, "publishStudyJsonV1", "publish_study_json_v1");
  const wasmValidateResultManifest = module && wasmFunction(
    module,
    "validateResultManifestJsonV1",
    "validate_result_manifest_json_v1",
  );
  const WasmAuthority = module?.WasmStudyAuthorityV1;

  return Object.freeze({
    implementation: module ? "wasm" : "browser-precheck",
    loadError,
    canRun: typeof WasmAuthority === "function",
    async hash(study) {
      // Unlike the other JSON-only exports, the hash boundary intentionally
      // returns the digest itself. Parsing a hex digest as JSON breaks whenever
      // its first characters happen to resemble a JSON number.
      if (wasmHash) return normalizeProtocolHashResult(wasmHash(JSON.stringify(study)));
      return sha256Hex(canonicalStudyJson(study));
    },
    async validate(study) {
      if (wasmValidate || wasmPublish) {
        try {
          const result = normalizeWasmResult((wasmValidate ?? wasmPublish)(JSON.stringify(study)));
          if (Array.isArray(result)) return { valid: result.length === 0, errors: result };
          if (result === null || result === undefined || result === true) return { valid: true, errors: [] };
          return result.valid === undefined ? { valid: true, errors: [] } : result;
        } catch (error) {
          const parsed = (() => {
            try { return JSON.parse(error?.message ?? String(error)); } catch { return undefined; }
          })();
          return { valid: false, errors: [parsed ?? { code: "validation", path: "study", message: error?.message ?? String(error) }] };
        }
      }
      return fallbackValidation(study);
    },
    async publish(study) {
      if (wasmPublish) return normalizeWasmResult(wasmPublish(JSON.stringify(study)));
      const published = globalThis.structuredClone
        ? globalThis.structuredClone(study)
        : JSON.parse(JSON.stringify(study));
      published.protocolHash = await sha256Hex(canonicalStudyJson(study));
      return published;
    },
    async validateResultManifest(manifest) {
      if (!wasmValidateResultManifest) {
        throw new Error("This build cannot validate ResultManifestV1 with the shared Rust/WASM core.");
      }
      return normalizeWasmResult(wasmValidateResultManifest(JSON.stringify(manifest)));
    },
    createAuthority(study, configuration, generation = 1) {
      if (!WasmAuthority) throw new Error("The shared WASM study authority is not available in this build.");
      return new WasmAuthority(JSON.stringify(study), JSON.stringify(configuration), BigInt(generation));
    },
  });
}
