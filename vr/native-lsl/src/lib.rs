use jni::objects::{JClass, JFloatArray, JString};
use jni::sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use labstream::{Channel, Format, Outlet, StreamInfo};
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};

const CHANNEL_LABELS: [&str; 8] = [
    "current_valence",
    "current_arousal",
    "target_valence",
    "target_arousal",
    "radius",
    "angle_degrees",
    "animation_active",
    "input_active",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    stream_name: String,
    stream_type: String,
    marker_name: String,
    sample_rate: u16,
    source_id: String,
    session_id: String,
}

struct Service {
    state: Outlet,
    markers: Outlet,
}

static SERVICE: OnceLock<Mutex<Option<Service>>> = OnceLock::new();

fn service() -> &'static Mutex<Option<Service>> {
    SERVICE.get_or_init(|| Mutex::new(None))
}

fn start(configuration: Configuration) -> Result<(), String> {
    if !(1..=240).contains(&configuration.sample_rate) {
        return Err("invalid_sample_rate".into());
    }
    let channels = CHANNEL_LABELS.map(|label| {
        Channel::new(label)
            .unit(if label == "angle_degrees" { "degrees" } else { "normalized" })
            .kind("Affect")
    });
    let state_info = StreamInfo::builder(&configuration.stream_name, &configuration.stream_type, Format::Float32)
        .rate(configuration.sample_rate as f64)
        .source_id(&format!("{}-state", configuration.source_id))
        .channels(channels)
        .build()
        .map_err(|_| "state_metadata_failed")?;
    let marker_info = StreamInfo::builder(&configuration.marker_name, "Markers", Format::String)
        .irregular()
        .source_id(&format!("{}-markers", configuration.source_id))
        .channels([Channel::new("marker").kind("Markers")])
        .build()
        .map_err(|_| "marker_metadata_failed")?;
    let state = Outlet::new(state_info).map_err(|_| "state_outlet_failed")?;
    let markers = Outlet::new(marker_info).map_err(|_| "marker_outlet_failed")?;
    markers.push_text(&format!("system:outlets_ready:{}", configuration.session_id))
        .map_err(|_| "initial_marker_failed")?;
    *service().lock().map_err(|_| "service_lock_failed")? = Some(Service { state, markers });
    Ok(())
}

#[no_mangle]
pub extern "system" fn Java_io_github_georgefejer91_affecttracker_vr_NativeLslBridge_nativeStart(
    mut env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    let result = (|| {
        let json: String = env.get_string(&input).map_err(|_| "invalid_jni_string")?.into();
        let configuration: Configuration = serde_json::from_str(&json).map_err(|_| "invalid_configuration")?;
        start(configuration)
    })();
    let value = match result { Ok(()) => "running".to_owned(), Err(error) => error.to_owned() };
    env.new_string(value).expect("status string").into_raw()
}

#[no_mangle]
pub extern "system" fn Java_io_github_georgefejer91_affecttracker_vr_NativeLslBridge_nativePushState(
    env: JNIEnv,
    _class: JClass,
    values: JFloatArray,
) -> jboolean {
    let mut sample = [0.0f32; 8];
    if env.get_array_length(&values).ok() != Some(8) || env.get_float_array_region(&values, 0, &mut sample).is_err() {
        return JNI_FALSE;
    }
    match service().lock().ok().and_then(|guard| guard.as_ref().map(|active| active.state.push(&sample).is_ok())) {
        Some(true) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

#[no_mangle]
pub extern "system" fn Java_io_github_georgefejer91_affecttracker_vr_NativeLslBridge_nativePushMarker(
    mut env: JNIEnv,
    _class: JClass,
    marker: JString,
) -> jboolean {
    let marker: String = match env.get_string(&marker) { Ok(value) => value.into(), Err(_) => return JNI_FALSE };
    match service().lock().ok().and_then(|guard| guard.as_ref().map(|active| active.markers.push_text(&marker).is_ok())) {
        Some(true) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

#[no_mangle]
pub extern "system" fn Java_io_github_georgefejer91_affecttracker_vr_NativeLslBridge_nativeStop(
    _env: JNIEnv,
    _class: JClass,
) {
    if let Ok(mut guard) = service().lock() { *guard = None; }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_schema_matches_affect_tracker_desktop() {
        assert_eq!(CHANNEL_LABELS.len(), 8);
        assert_eq!(CHANNEL_LABELS[0], "current_valence");
        assert_eq!(CHANNEL_LABELS[7], "input_active");
    }
}
