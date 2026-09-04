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

#[cfg(all(feature = "lsl-streaming", any(target_os = "windows", test)))]
fn build_stream_descriptions(
    settings: &ResearchLslSettingsV1,
    sample_rate_hz: u16,
    run_id: &str,
) -> ResearchResult<(labstream::StreamInfo, labstream::StreamInfo)> {
    use labstream::{Channel, Format, StreamInfo};

    if !(1..=240).contains(&sample_rate_hz) {
        return Err(CommandError::invalid_contract(
            "The LSL sample rate must be between 1 and 240 Hz.",
        ));
    }

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
    let marker_info = StreamInfo::builder(&settings.marker_stream, "Markers", Format::String)
        .irregular()
        .source_id(&marker_source)
        .channels([Channel::new("marker").kind("Markers")])
        .build()
        .map_err(|_| CommandError::io("The LSL marker metadata was rejected."))?;
    Ok((state_info, marker_info))
}

#[cfg(all(feature = "lsl-streaming", target_os = "windows"))]
mod implementation {
    use super::*;
    use labstream::Outlet;

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
            let (state_info, marker_info) =
                build_stream_descriptions(settings, sample_rate_hz, run_id)?;
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

        #[cfg(test)]
        pub(crate) fn wait_for_consumers(&self, timeout: std::time::Duration) -> bool {
            self.state_outlet.wait_for_consumers(timeout)
                && self.marker_outlet.wait_for_consumers(timeout)
        }
    }
}

#[cfg(not(all(feature = "lsl-streaming", target_os = "windows")))]
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

    fn enabled_settings(source_id: &str) -> ResearchLslSettingsV1 {
        ResearchLslSettingsV1 {
            enabled: true,
            state_stream: "AffectState".to_owned(),
            stream_type: "Affect".to_owned(),
            marker_stream: "AffectMarkers".to_owned(),
            source_id: source_id.to_owned(),
        }
    }

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
        assert_eq!(
            CHANNEL_LABELS,
            [
                "current_valence",
                "current_arousal",
                "target_valence",
                "target_arousal",
                "radius",
                "angle_degrees",
                "animation_active",
                "input_active",
            ]
        );
        assert_eq!(values, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 1.0, 0.0]);
    }

    #[test]
    fn marker_contract_is_bounded_and_code_only() {
        assert!(validate_marker("stimulus_started:video-1").is_ok());
        assert!(validate_marker(&"a".repeat(256)).is_ok());
        assert!(validate_marker(&"a".repeat(257)).is_err());
        assert!(validate_marker("C:\\private\\participant name").is_err());
        assert!(validate_marker("participant name").is_err());
        assert!(validate_marker("participant/name").is_err());
        assert!(validate_marker("participant\nname").is_err());
        assert!(validate_marker("participant-é").is_err());
        assert!(validate_marker("").is_err());
    }

    #[cfg(feature = "lsl-streaming")]
    #[test]
    fn stream_metadata_is_the_exact_research_contract() {
        use labstream::Format;

        let settings = enabled_settings("affect-research-test");
        let (state, marker) = build_stream_descriptions(&settings, 130, "run-001").unwrap();

        assert_eq!(state.name(), "AffectState");
        assert_eq!(state.stream_type(), "Affect");
        assert_eq!(state.source_id(), "affect-research-test:state:run-001");
        assert_eq!(state.format(), Format::Float32);
        assert_eq!(state.rate(), 130.0);
        assert!(state.is_regular());
        assert_eq!(state.channel_count(), 8);
        assert_eq!(
            state.channels(),
            CHANNEL_LABELS
                .iter()
                .map(|label| {
                    labstream::Channel::new(label)
                        .unit(if *label == "angle_degrees" {
                            "degrees"
                        } else if matches!(*label, "animation_active" | "input_active") {
                            "boolean"
                        } else {
                            "normalized"
                        })
                        .kind("Affect")
                })
                .collect::<Vec<_>>()
        );

        assert_eq!(marker.name(), "AffectMarkers");
        assert_eq!(marker.stream_type(), "Markers");
        assert_eq!(marker.source_id(), "affect-research-test:markers:run-001");
        assert_eq!(marker.format(), Format::String);
        assert_eq!(marker.rate(), 0.0);
        assert!(!marker.is_regular());
        assert_eq!(marker.channel_count(), 1);
        assert_eq!(
            marker.channels(),
            vec![labstream::Channel::new("marker").kind("Markers")]
        );
    }

    #[cfg(feature = "lsl-streaming")]
    #[test]
    fn stream_metadata_rejects_out_of_contract_sample_rates() {
        let settings = enabled_settings("affect-research-test");
        for rate in [0, 241] {
            let error = build_stream_descriptions(&settings, rate, "run-001").unwrap_err();
            assert_eq!(error.code, "invalid_research_contract");
        }
    }

    #[cfg(not(all(feature = "lsl-streaming", target_os = "windows")))]
    #[test]
    fn unavailable_builds_fail_closed() {
        let settings = enabled_settings("affect-research-test");
        let start_error = match LslService::start(&settings, 130, "test-run") {
            Ok(_) => panic!("an unavailable build must not create LSL outlets"),
            Err(error) => error,
        };
        assert_eq!(start_error.code, "forbidden_operation");

        let service = LslService;
        let state_error = service
            .push_state(LslState {
                current_valence: 0.0,
                current_arousal: 0.0,
                target_valence: 0.0,
                target_arousal: 0.0,
                radius: 0.0,
                angle_degrees: 0.0,
                animation_active: false,
                input_active: false,
            })
            .unwrap_err();
        assert_eq!(state_error.code, "forbidden_operation");
        assert_eq!(
            service.push_marker("session_started").unwrap_err().code,
            "forbidden_operation"
        );

        let readiness = probe_readiness(&settings, 130);
        assert!(!readiness.ready);
        assert!(readiness.enabled);
        assert_eq!(readiness.channel_labels, CHANNEL_LABELS);
    }

    #[cfg(all(feature = "lsl-streaming", target_os = "windows"))]
    fn assert_wire_metadata(
        state: &labstream::StreamInfo,
        marker: &labstream::StreamInfo,
        source_id: &str,
        run_id: &str,
    ) {
        use labstream::Format;

        assert_eq!(state.name(), "AffectState");
        assert_eq!(state.stream_type(), "Affect");
        assert_eq!(state.source_id(), format!("{source_id}:state:{run_id}"));
        assert_eq!(state.format(), Format::Float32);
        assert_eq!(state.rate(), 130.0);
        assert!(state.is_regular());
        assert_eq!(
            state
                .channels()
                .iter()
                .map(|channel| channel.label.as_str())
                .collect::<Vec<_>>(),
            CHANNEL_LABELS
        );
        assert_eq!(
            state
                .channels()
                .iter()
                .map(|channel| channel.unit.as_str())
                .collect::<Vec<_>>(),
            [
                "normalized",
                "normalized",
                "normalized",
                "normalized",
                "normalized",
                "degrees",
                "boolean",
                "boolean",
            ]
        );
        assert!(state
            .channels()
            .iter()
            .all(|channel| channel.kind == "Affect"));

        assert_eq!(marker.name(), "AffectMarkers");
        assert_eq!(marker.stream_type(), "Markers");
        assert_eq!(marker.source_id(), format!("{source_id}:markers:{run_id}"));
        assert_eq!(marker.format(), Format::String);
        assert_eq!(marker.rate(), 0.0);
        assert!(!marker.is_regular());
        assert_eq!(
            marker.channels(),
            vec![labstream::Channel::new("marker").kind("Markers")]
        );
    }

    #[cfg(all(feature = "lsl-streaming", target_os = "windows"))]
    fn run_loopback_round(
        settings: &ResearchLslSettingsV1,
        run_id: &str,
        state: LslState,
        marker: &str,
    ) -> (f64, f64) {
        use labstream::{Buffer, Inlet, Post, Query};
        use std::time::Duration;

        const TIMEOUT: Duration = Duration::from_secs(5);

        let service = LslService::start(settings, 130, run_id).expect("start Research LSL");
        let state_source = format!("{}:state:{run_id}", settings.source_id);
        let marker_source = format!("{}:markers:{run_id}", settings.source_id);
        let discovered_state = labstream::resolve_first(&Query::source_id(&state_source), TIMEOUT)
            .expect("resolve state outlet")
            .expect("state outlet is discoverable");
        let discovered_marker =
            labstream::resolve_first(&Query::source_id(&marker_source), TIMEOUT)
                .expect("resolve marker outlet")
                .expect("marker outlet is discoverable");
        let state_info = discovered_state
            .fetch(TIMEOUT)
            .expect("fetch state metadata");
        let marker_info = discovered_marker
            .fetch(TIMEOUT)
            .expect("fetch marker metadata");
        assert_wire_metadata(
            &state_info,
            &marker_info,
            settings.source_id.as_str(),
            run_id,
        );

        let mut state_inlet = Inlet::builder(&state_info)
            .buffer(Buffer::Seconds(1.0))
            .recover(false)
            .postprocess(Post::NONE)
            .open(TIMEOUT)
            .expect("open state inlet");
        let mut marker_inlet = Inlet::builder(&marker_info)
            .buffer(Buffer::Samples(16))
            .recover(false)
            .postprocess(Post::NONE)
            .open(TIMEOUT)
            .expect("open marker inlet");
        assert!(
            service.wait_for_consumers(TIMEOUT),
            "both outlets must observe their inlet before the test pushes data"
        );

        let sent_state_at = service.push_state(state).expect("push state");
        let sent_marker_at = service.push_marker(marker).expect("push marker");
        let (received_state_at, received_state) = state_inlet
            .pull::<f32>(TIMEOUT)
            .expect("pull state")
            .expect("receive state");
        let (received_marker_at, received_marker) = marker_inlet
            .pull_text(TIMEOUT)
            .expect("pull marker")
            .expect("receive marker");

        assert_eq!(received_state, state_values(state));
        assert_eq!(received_marker, vec![marker.to_owned()]);
        assert!((received_state_at - sent_state_at).abs() <= f64::EPSILON);
        assert!((received_marker_at - sent_marker_at).abs() <= f64::EPSILON);

        let invalid = service.push_marker("participant free text").unwrap_err();
        assert_eq!(invalid.code, "invalid_research_contract");
        assert!(marker_inlet
            .pull_text(Duration::from_millis(100))
            .expect("check marker stream")
            .is_none());

        drop(marker_inlet);
        drop(state_inlet);
        drop(service);
        (sent_state_at, sent_marker_at)
    }

    #[cfg(all(feature = "lsl-streaming", target_os = "windows"))]
    #[test]
    #[ignore = "requires explicit AFFECT_RESEARCH_RUN_LSL_LOOPBACK=1 Windows network opt-in"]
    fn windows_lsl_loopback_conformance() {
        assert_eq!(
            std::env::var("AFFECT_RESEARCH_RUN_LSL_LOOPBACK").as_deref(),
            Ok("1"),
            "set AFFECT_RESEARCH_RUN_LSL_LOOPBACK=1 to run real local LSL discovery/transport"
        );

        let source_id = format!("affect-research-loopback-{}", Uuid::new_v4());
        let settings = enabled_settings(&source_id);
        let first = run_loopback_round(
            &settings,
            "attempt-1",
            LslState {
                current_valence: -0.75,
                current_arousal: 0.25,
                target_valence: 1.0,
                target_arousal: -1.0,
                radius: 0.5,
                angle_degrees: 270.0,
                animation_active: true,
                input_active: false,
            },
            "stimulus_started:stimulus-001",
        );
        let second = run_loopback_round(
            &settings,
            "attempt-2",
            LslState {
                current_valence: 0.5,
                current_arousal: -0.5,
                target_valence: 0.0,
                target_arousal: 0.75,
                radius: 0.25,
                angle_degrees: 90.0,
                animation_active: false,
                input_active: true,
            },
            "session_completed",
        );
        assert!(second.0 >= first.0, "state timestamps cannot go backward");
        assert!(second.1 >= first.1, "marker timestamps cannot go backward");
    }
}
