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
    use lsl::{ChannelFormat, Pushable, StreamInfo, StreamOutlet, IRREGULAR_RATE};

    pub struct LslService {
        state_outlet: StreamOutlet,
        marker_outlet: StreamOutlet,
    }

    impl LslService {
        pub fn start(settings: &LslSettings, session_id: &str) -> Result<Self, String> {
            let state_source = format!("{}-state", settings.source_id);
            let marker_source = format!("{}-markers", settings.source_id);
            let mut state_info = StreamInfo::new(
                &settings.stream_name,
                &settings.stream_type,
                CHANNEL_LABELS.len() as u32,
                settings.sample_rate as f64,
                ChannelFormat::Float32,
                &state_source,
            )
            .map_err(|_| "Could not create the LSL state stream metadata.".to_owned())?;
            add_state_metadata(&mut state_info, settings, session_id);

            let mut marker_info = StreamInfo::new(
                &settings.marker_name,
                "Markers",
                1,
                IRREGULAR_RATE,
                ChannelFormat::String,
                &marker_source,
            )
            .map_err(|_| "Could not create the LSL marker stream metadata.".to_owned())?;
            {
                let mut desc = marker_info.desc();
                desc.append_child_value("application", "Affect Tracker Desktop");
                desc.append_child_value("schema_version", "1");
                desc.append_child_value("session_id", session_id);
                let mut channels = desc.append_child("channels");
                let mut channel = channels.append_child("channel");
                channel.append_child_value("label", "marker");
                channel.append_child_value("type", "Markers");
            }

            let state_outlet = StreamOutlet::new(&state_info, 0, 30)
                .map_err(|_| "Could not open the LSL state outlet.".to_owned())?;
            let marker_outlet = StreamOutlet::new(&marker_info, 0, 30)
                .map_err(|_| "Could not open the LSL marker outlet.".to_owned())?;
            Ok(Self {
                state_outlet,
                marker_outlet,
            })
        }

        pub fn push_state(&self, snapshot: &AffectSnapshot) -> Result<(), String> {
            self.state_outlet
                .push_sample(&sample_values(snapshot))
                .map_err(|_| "LSL rejected an affect sample.".to_owned())
        }

        pub fn push_marker(&self, marker: &str) -> Result<(), String> {
            self.marker_outlet
                .push_sample(&vec![marker])
                .map_err(|_| "LSL rejected a marker.".to_owned())
        }
    }

    fn add_state_metadata(info: &mut StreamInfo, settings: &LslSettings, session_id: &str) {
        let mut desc = info.desc();
        desc.append_child_value("application", "Affect Tracker Desktop");
        desc.append_child_value("schema_version", "1");
        desc.append_child_value("session_id", session_id);
        desc.append_child_value("coordinate_range", "[-1,1]");
        desc.append_child_value("sample_rate_hz", &settings.sample_rate.to_string());
        let mut channels = desc.append_child("channels");
        for label in CHANNEL_LABELS {
            let mut channel = channels.append_child("channel");
            channel.append_child_value("label", label);
            channel.append_child_value("type", "Affect");
            channel.append_child_value(
                "unit",
                if label == "angle_degrees" {
                    "degrees"
                } else {
                    "normalized"
                },
            );
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
