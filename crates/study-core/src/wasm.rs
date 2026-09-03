use crate::{
    protocol_hash, CoreErrorCodeV1, CoreErrorV1, CoreResult, ReducerOutcomeV1, ResultManifestV1,
    RunConfigurationV1, StudyActionV1, StudyAuthorityV1, StudyDefinitionV1,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// JSON-only WASM boundary. It deliberately exposes no browser or platform API.
#[wasm_bindgen]
pub struct WasmStudyAuthorityV1 {
    inner: StudyAuthorityV1,
}

#[wasm_bindgen]
impl WasmStudyAuthorityV1 {
    /// Creates an authority from a published study and run configuration JSON.
    #[wasm_bindgen(constructor)]
    pub fn new(
        study_json: &str,
        configuration_json: &str,
        authority_generation: u64,
    ) -> Result<WasmStudyAuthorityV1, JsValue> {
        let study: StudyDefinitionV1 = from_json(study_json).map_err(to_js_error)?;
        let configuration: RunConfigurationV1 =
            from_json(configuration_json).map_err(to_js_error)?;
        let inner = StudyAuthorityV1::new(study, configuration, authority_generation)
            .map_err(to_js_error)?;
        Ok(Self { inner })
    }

    /// Returns the current strict `RunStateV1` JSON.
    #[wasm_bindgen(js_name = stateJson)]
    pub fn state_json(&self) -> Result<String, JsValue> {
        to_json(self.inner.state()).map_err(to_js_error)
    }

    /// Applies one strict `StudyActionV1` JSON and returns `ReducerOutcomeV1`.
    #[wasm_bindgen(js_name = applyJson)]
    pub fn apply_json(&mut self, action_json: &str) -> Result<String, JsValue> {
        let action: StudyActionV1 = from_json(action_json).map_err(to_js_error)?;
        let outcome: ReducerOutcomeV1 = self.inner.apply(action).map_err(to_js_error)?;
        to_json(&outcome).map_err(to_js_error)
    }
}

/// Validates a draft JSON declaration and returns its immutable published form.
#[wasm_bindgen(js_name = publishStudyJsonV1)]
pub fn publish_study_json_v1(study_json: &str) -> Result<String, JsValue> {
    let study: StudyDefinitionV1 = from_json(study_json).map_err(to_js_error)?;
    let published = study.published().map_err(to_js_error)?;
    to_json(&published).map_err(to_js_error)
}

/// Returns the canonical lowercase SHA-256 for valid study JSON.
#[wasm_bindgen(js_name = protocolHashJsonV1)]
pub fn protocol_hash_json_v1(study_json: &str) -> Result<String, JsValue> {
    let study: StudyDefinitionV1 = from_json(study_json).map_err(to_js_error)?;
    protocol_hash(&study)
        .map(|hash| hash.0)
        .map_err(to_js_error)
}

/// Strictly decodes and validates a browser-produced `ResultManifestV1`.
/// Returning normalized JSON supplies one fail-closed contract boundary while
/// keeping storage and download capabilities outside the pure WASM core.
#[wasm_bindgen(js_name = validateResultManifestJsonV1)]
pub fn validate_result_manifest_json_v1(manifest_json: &str) -> Result<String, JsValue> {
    let manifest: ResultManifestV1 = from_json(manifest_json).map_err(to_js_error)?;
    manifest.validate().map_err(to_js_error)?;
    to_json(&manifest).map_err(to_js_error)
}

fn from_json<T: DeserializeOwned>(json: &str) -> CoreResult<T> {
    serde_json::from_str(json).map_err(|error| {
        CoreErrorV1::new(
            CoreErrorCodeV1::InvalidSchema,
            "json",
            format!("strict JSON decoding failed: {error}"),
        )
    })
}

fn to_json<T: Serialize>(value: &T) -> CoreResult<String> {
    serde_json::to_string(value).map_err(|error| {
        CoreErrorV1::new(
            CoreErrorCodeV1::SerializationFailed,
            "json",
            format!("JSON encoding failed: {error}"),
        )
    })
}

fn to_js_error(error: CoreErrorV1) -> JsValue {
    let json = serde_json::to_string(&error).unwrap_or_else(|_| {
        "{\"code\":\"serializationFailed\",\"path\":\"json\",\"message\":\"error encoding failed\"}"
            .to_owned()
    });
    JsValue::from_str(&json)
}
