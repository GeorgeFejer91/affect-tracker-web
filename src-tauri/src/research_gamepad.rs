//! Safe Windows gamepad event source for the Research input authority.
//!
//! The adapter deliberately exposes only normalized button/axis changes and an
//! ephemeral process-local device number. It does not expose names, GUIDs,
//! vendor/product identifiers, force feedback, or native handles. Product
//! focus, binding, receipt, and run policy remain in `research_input`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GamepadInputEvent {
    Connected {
        device: u32,
    },
    Disconnected {
        device: u32,
    },
    Button {
        device: u32,
        button: u8,
        pressed: bool,
    },
    Axis {
        device: u32,
        axis: u8,
        value: f64,
    },
}

type GamepadSink = Arc<dyn Fn(GamepadInputEvent) + Send + Sync>;

pub struct GamepadBackend {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl GamepadBackend {
    pub fn start(sink: GamepadSink) -> Result<Self, ()> {
        start_platform_backend(sink)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
        self.running.store(false, Ordering::Release);
    }
}

impl Drop for GamepadBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(target_os = "windows")]
fn start_platform_backend(sink: GamepadSink) -> Result<GamepadBackend, ()> {
    use gilrs::{EventType, GilrsBuilder};

    let stop = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let worker_running = Arc::clone(&running);
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("affect-research-gamepad".to_owned())
        .spawn(move || {
            let Ok(mut gilrs) = GilrsBuilder::new().with_force_feedback(false).build() else {
                let _ = startup_sender.send(false);
                return;
            };
            worker_running.store(true, Ordering::Release);
            if startup_sender.send(true).is_err() {
                worker_running.store(false, Ordering::Release);
                return;
            }
            while !worker_stop.load(Ordering::Acquire) {
                let Some(event) = gilrs.next_event_blocking(Some(Duration::from_millis(25))) else {
                    continue;
                };
                let Ok(device) = u32::try_from(usize::from(event.id)) else {
                    continue;
                };
                let projected = match event.event {
                    EventType::Connected => Some(GamepadInputEvent::Connected { device }),
                    EventType::Disconnected => Some(GamepadInputEvent::Disconnected { device }),
                    EventType::ButtonPressed(button, _) => {
                        standard_button(button).map(|button| GamepadInputEvent::Button {
                            device,
                            button,
                            pressed: true,
                        })
                    }
                    EventType::ButtonReleased(button, _) => {
                        standard_button(button).map(|button| GamepadInputEvent::Button {
                            device,
                            button,
                            pressed: false,
                        })
                    }
                    EventType::AxisChanged(axis, value, _) => {
                        standard_axis(axis).map(|(axis, invert_for_web_contract)| {
                            let value = f64::from(value.clamp(-1.0, 1.0));
                            GamepadInputEvent::Axis {
                                device,
                                axis,
                                // XInput stick-up is positive. InputBindingV1 follows
                                // the Web Gamepad raw-axis convention, where it is negative.
                                value: if invert_for_web_contract {
                                    -value
                                } else {
                                    value
                                },
                            }
                        })
                    }
                    _ => None,
                };
                if let Some(projected) = projected {
                    sink(projected);
                }
                gilrs.inc();
            }
            worker_running.store(false, Ordering::Release);
        })
        .map_err(|_| ())?;

    match startup_receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(true) => Ok(GamepadBackend {
            stop,
            running,
            worker: Mutex::new(Some(worker)),
        }),
        Ok(false) | Err(_) => {
            stop.store(true, Ordering::Release);
            let _ = worker.join();
            Err(())
        }
    }
}

#[cfg(target_os = "windows")]
fn standard_button(button: gilrs::Button) -> Option<u8> {
    use gilrs::Button;
    match button {
        Button::South => Some(0),
        Button::East => Some(1),
        Button::West => Some(2),
        Button::North => Some(3),
        Button::LeftTrigger => Some(4),
        Button::RightTrigger => Some(5),
        Button::LeftTrigger2 => Some(6),
        Button::RightTrigger2 => Some(7),
        Button::Select => Some(8),
        Button::Start => Some(9),
        Button::LeftThumb => Some(10),
        Button::RightThumb => Some(11),
        Button::DPadUp => Some(12),
        Button::DPadDown => Some(13),
        Button::DPadLeft => Some(14),
        Button::DPadRight => Some(15),
        Button::Mode => Some(16),
        Button::C => Some(17),
        Button::Z => Some(18),
        Button::Unknown => None,
    }
}

#[cfg(target_os = "windows")]
fn standard_axis(axis: gilrs::Axis) -> Option<(u8, bool)> {
    use gilrs::Axis;
    match axis {
        Axis::LeftStickX => Some((0, false)),
        Axis::LeftStickY => Some((1, true)),
        Axis::RightStickX => Some((2, false)),
        Axis::RightStickY => Some((3, true)),
        Axis::LeftZ | Axis::RightZ | Axis::DPadX | Axis::DPadY | Axis::Unknown => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn start_platform_backend(_sink: GamepadSink) -> Result<GamepadBackend, ()> {
    Err(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use gilrs::{Axis, Button};

    #[test]
    fn standard_buttons_match_the_web_gamepad_indices_used_by_the_contract() {
        assert_eq!(standard_button(Button::South), Some(0));
        assert_eq!(standard_button(Button::DPadUp), Some(12));
        assert_eq!(standard_button(Button::DPadRight), Some(15));
        assert_eq!(standard_button(Button::Unknown), None);
    }

    #[test]
    fn xinput_stick_axes_project_to_web_gamepad_orientation() {
        assert_eq!(standard_axis(Axis::LeftStickX), Some((0, false)));
        assert_eq!(standard_axis(Axis::LeftStickY), Some((1, true)));
        assert_eq!(standard_axis(Axis::RightStickX), Some((2, false)));
        assert_eq!(standard_axis(Axis::RightStickY), Some((3, true)));
        assert_eq!(standard_axis(Axis::DPadX), None);
    }
}
