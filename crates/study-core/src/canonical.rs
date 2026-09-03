use crate::{CoreErrorCodeV1, CoreErrorV1, CoreResult, Sha256HexV1, StudyDefinitionV1};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Canonical JSON/hash algorithm recorded by protocol version 1.
pub const CANONICAL_PROTOCOL_ALGORITHM_V1: &str = "canonical-json-sha256-v1";

/// Produces deterministic UTF-8 protocol bytes with sorted object keys.
///
/// The declaration's `protocolHash` field is deliberately omitted so the hash
/// can be embedded back into the immutable published declaration.
pub fn canonical_protocol_bytes(study: &StudyDefinitionV1) -> CoreResult<Vec<u8>> {
    let mut normalized = study.clone();
    normalized.protocol_hash = None;
    normalized.validate_draft()?;
    let value = serde_json::to_value(normalized).map_err(serialization_error)?;
    let mut output = String::new();
    write_canonical_json(&value, &mut output)?;
    Ok(output.into_bytes())
}

/// Returns the lowercase SHA-256 of [`canonical_protocol_bytes`].
pub fn protocol_hash(study: &StudyDefinitionV1) -> CoreResult<Sha256HexV1> {
    let bytes = canonical_protocol_bytes(study)?;
    let digest = Sha256::digest(bytes);
    Ok(Sha256HexV1(lower_hex(&digest)))
}

pub(crate) fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn write_canonical_json(value: &Value, output: &mut String) -> CoreResult<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).map_err(serialization_error)?);
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(serialization_error)?);
                output.push(':');
                let member = values.get(*key).ok_or_else(|| {
                    CoreErrorV1::new(
                        CoreErrorCodeV1::SerializationFailed,
                        "study",
                        "canonical object member disappeared during serialization",
                    )
                })?;
                write_canonical_json(member, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn serialization_error(error: serde_json::Error) -> CoreErrorV1 {
    CoreErrorV1::new(
        CoreErrorCodeV1::SerializationFailed,
        "study",
        format!("could not serialize the study contract: {error}"),
    )
}
