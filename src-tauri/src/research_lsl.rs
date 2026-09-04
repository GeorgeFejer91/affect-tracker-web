use crate::research_contracts::ResearchLslSettingsV1;
use crate::research_error::{CommandError, ResearchResult};
use serde::Serialize;
use uuid::Uuid;

pub const CHANNEL_LABELS: [&str; 8] = [
    "current_valence",
    "current_arousal",
    "target_valence",
    "target_arousal",
    "radius",
    "angle_degrees",
    "animation_active",
    "input_active",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LslReadiness {
    pub ready: bool,
    pub enabled: bool,
    pub reason_code: String,
    pub channel_labels: [&'static str; 8],
}

pub fn probe_readiness(settings: &ResearchLslSettingsV1, sample_rate_hz: u16) -> LslReadiness {
    if !settings.enabled {
        return LslReadiness {
            ready: true,
            enabled: false,
            reason_code: "disabled".to_owned(),
            channel_labels: CHANNEL_LABELS,
        };
    }
    if !cfg!(target_os = "windows") {
        return LslReadiness {
            ready: false,
            enabled: true,
            reason_code: "tauri-windows-required".to_owned(),
            channel_labels: CHANNEL_LABELS,
        };
    }
    let probe_id = format!("preflight-{}", Uuid::new_v4());
    match LslService::start(settings, sample_rate_hz, &probe_id) {
        Ok(_service) => LslReadiness {
            ready: true,
            enabled: true,
            reason_code: "ready".to_owned(),
            channel_labels: CHANNEL_LABELS,
        },
        Err(_) => LslReadiness {
            ready: false,
            enabled: true,
            reason_code: "outlet-unavailable".to_owned(),
            channel_labels: CHANNEL_LABELS,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LslState {
    pub current_valence: f64,
    pub current_arousal: f64,
    pub target_valence: f64,
    pub target_arousal: f64,
    pub radius: f64,
    pub angle_degrees: f64,
    pub animation_active: bool,
    pub input_active: bool,
}

#[cfg(any(feature = "lsl-streaming", test))]
pub fn state_values(state: LslState) -> [f32; 8] {
    [
        state.current_valence as f32,
        state.current_arousal as f32,
        state.target_valence as f32,
        state.target_arousal as f32,
        state.radius as f32,
        state.angle_degrees as f32,
        u8::from(state.animation_active) as f32,
        u8::from(state.input_active) as f32,
    ]
}

#[cfg(any(feature = "lsl-streaming", test))]
pub fn validate_marker(marker: &str) -> ResearchResult<()> {
    if marker.is_empty()
        || marker.len() > 256
        || !marker
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        return Err(CommandError::invalid_contract(
            "An LSL marker must be a bounded semantic code.",
        ));
    }
    Ok(())
}

#[cfg(feature = "lsl-streaming")]
mod implementation {
    use super::*;
    use labstream::{Channel, Format, Outlet, StreamInfo};

    pub struct LslService {
        state_outlet: Outlet,
        marker_outlet: Outlet,
    }

    impl LslService {
        pub fn start(
            settings: &ResearchLslSettingsV1,
            sample_rate_hz: u16,
            run_id: &str,
        ) -> ResearchResult<Self> {
            let state_source = format!("{}:state:{run_id}", settings.source_id);
            let marker_source = format!("{}:markers:{run_id}", settings.source_id);
            let channels = CHANNEL_LABELS.map(|label| {
                Channel::new(label)
                    .unit(if label == "angle_degrees" {
                        "degrees"
                    } else if matches!(label, "animation_active" | "input_active") {
                        "boolean"
                    } else {
                        "normalized"
                    })
                    .kind("Affect")
            });
            let state_info = StreamInfo::builder(
                &settings.state_stream,
                &settings.stream_type,
                Format::Float32,
            )
            .rate(f64::from(sample_rate_hz))
            .source_id(&state_source)
            .channels(channels)
            .build()
            .map_err(|_| CommandError::io("The LSL state stream metadata was rejected."))?;
            let marker_info =
                StreamInfo::builder(&settings.marker_stream, "Markers", Format::String)
                    .irregular()
                    .source_id(&marker_source)
                    .channels([Channel::new("marker").kind("Markers")])
                    .build()
                    .map_err(|_| CommandError::io("The LSL marker metadata was rejected."))?;
            let state_outlet = Outlet::new(state_info)
                .map_err(|_| CommandError::io("The LSL state outlet could not start."))?;
            let marker_outlet = Outlet::new(marker_info)
                .map_err(|_| CommandError::io("The LSL marker outlet could not start."))?;
            Ok(Self {
                state_outlet,
                marker_outlet,
            })
        }

        pub fn push_state(&self, state: LslState) -> ResearchResult<f64> {
            let timestamp = labstream::clock();
            self.state_outlet
                .push_at(&state_values(state), timestamp)
                .map_err(|_| CommandError::io("LSL rejected an affect state sample."))?;
            Ok(timestamp)
        }

        pub fn push_marker(&self, marker: &str) -> ResearchResult<f64> {
            validate_marker(marker)?;
            let timestamp = labstream::clock();
            self.marker_outlet
                .push_text_at(marker, timestamp)
                .map_err(|_| CommandError::io("LSL rejected a lifecycle marker."))?;
            Ok(timestamp)
        }
    }
}

#[cfg(not(feature = "lsl-streaming"))]
mod implementation {
    use super::*;

    pub struct LslService;

    impl LslService {
        pub fn start(_: &ResearchLslSettingsV1, _: u16, _: &str) -> ResearchResult<Self> {
            Err(CommandError::forbidden(
                "This Affect Research build does not include LSL support.",
            ))
        }

        pub fn push_state(&self, _: LslState) -> ResearchResult<f64> {
            Err(CommandError::forbidden(
                "This Affect Research build does not include LSL support.",
            ))
        }

        pub fn push_marker(&self, _: &str) -> ResearchResult<f64> {
            Err(CommandError::forbidden(
                "This Affect Research build does not include LSL support.",
            ))
        }
    }
}

pub use implementation::LslService;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_channel_order_is_the_research_contract() {
        let values = state_values(LslState {
            current_valence: 1.0,
            current_arousal: 2.0,
            target_valence: 3.0,
            target_arousal: 4.0,
            radius: 5.0,
            angle_degrees: 6.0,
            animation_active: true,
            input_active: false,
        });
        assert_eq!(CHANNEL_LABELS.len(), 8);
        assert_eq!(values, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 1.0, 0.0]);
    }

    #[test]
    fn markers_cannot_carry_names_paths_or_free_text() {
        assert!(validate_marker("stimulus_started:video-1").is_ok());
        assert!(validate_marker("C:\\private\\participant name").is_err());
        assert!(validate_marker("").is_err());
    }
}
