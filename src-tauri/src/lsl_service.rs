use crate::domain::AffectSnapshot;
use crate::settings::LslSettings;

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

pub fn sample_values(snapshot: &AffectSnapshot) -> Vec<f32> {
    vec![
        snapshot.current_x,
        snapshot.current_y,
        snapshot.target_x,
        snapshot.target_y,
        snapshot.radius,
        snapshot.angle_degrees,
        if snapshot.animation_active { 1.0 } else { 0.0 },
        if snapshot.input_active { 1.0 } else { 0.0 },
    ]
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
        pub fn start(settings: &LslSettings, _session_id: &str) -> Result<Self, String> {
            let state_source = format!("{}-state", settings.source_id);
            let marker_source = format!("{}-markers", settings.source_id);
            let channels = CHANNEL_LABELS.map(|label| {
                Channel::new(label)
                    .unit(if label == "angle_degrees" {
                        "degrees"
                    } else {
                        "normalized"
                    })
                    .kind("Affect")
            });
            let state_info = StreamInfo::builder(
                &settings.stream_name,
                &settings.stream_type,
                Format::Float32,
            )
            .rate(settings.sample_rate as f64)
            .source_id(&state_source)
            .channels(channels)
            .build()
            .map_err(|error| format!("Could not create the LSL state metadata: {error}"))?;
            let marker_info = StreamInfo::builder(&settings.marker_name, "Markers", Format::String)
                .irregular()
                .source_id(&marker_source)
                .channels([Channel::new("marker").kind("Markers")])
                .build()
                .map_err(|error| format!("Could not create the LSL marker metadata: {error}"))?;

            let state_outlet = Outlet::new(state_info)
                .map_err(|_| "Could not open the LSL state outlet.".to_owned())?;
            let marker_outlet = Outlet::new(marker_info)
                .map_err(|_| "Could not open the LSL marker outlet.".to_owned())?;
            Ok(Self {
                state_outlet,
                marker_outlet,
            })
        }

        pub fn push_state(&self, snapshot: &AffectSnapshot) -> Result<(), String> {
            self.state_outlet
                .push(&sample_values(snapshot))
                .map_err(|_| "LSL rejected an affect sample.".to_owned())
        }

        pub fn push_marker(&self, marker: &str) -> Result<(), String> {
            self.marker_outlet
                .push_text(marker)
                .map_err(|_| "LSL rejected a marker.".to_owned())
        }
    }
}

#[cfg(not(feature = "lsl-streaming"))]
mod implementation {
    use super::*;

    pub struct LslService;

    impl LslService {
        pub fn start(_: &LslSettings, _: &str) -> Result<Self, String> {
            Err("This build was compiled without LSL support.".to_owned())
        }

        pub fn push_state(&self, _: &AffectSnapshot) -> Result<(), String> {
            Err("This build was compiled without LSL support.".to_owned())
        }

        pub fn push_marker(&self, _: &str) -> Result<(), String> {
            Err("This build was compiled without LSL support.".to_owned())
        }
    }
}

pub use implementation::LslService;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsl_schema_has_expected_order_and_length() {
        assert_eq!(CHANNEL_LABELS.len(), 8);
        assert_eq!(CHANNEL_LABELS[0], "current_valence");
        assert_eq!(CHANNEL_LABELS[7], "input_active");
    }
}
