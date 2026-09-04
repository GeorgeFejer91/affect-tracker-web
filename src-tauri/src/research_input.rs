use crate::research_contracts::{DigitalInputTokenV1, DirectionV1, InputBindingV1, InputKindV1};
use crate::research_error::{CommandError, ResearchResult};
use monio::{Button, Event, EventType, Hook, ScrollDirection};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub struct NativeInputMonitor {
    hook: Option<Hook>,
}

#[derive(Debug, Clone)]
pub struct NativeDigitalInput {
    pub direction: DirectionV1,
    pub detail: String,
    pub apply_step: bool,
    pub input_active: bool,
    pub impulse: bool,
}

impl NativeInputMonitor {
    pub fn start(
        binding: &InputBindingV1,
        on_input: impl Fn(NativeDigitalInput) + Send + Sync + 'static,
    ) -> ResearchResult<Self> {
        if binding.kind != InputKindV1::Digital {
            return Ok(Self { hook: None });
        }
        let directions = binding.directions.clone().ok_or_else(|| {
            CommandError::invalid_contract("Digital input directions are missing.")
        })?;
        let needs_native_hook = [
            &directions.up,
            &directions.down,
            &directions.left,
            &directions.right,
        ]
        .into_iter()
        .any(|token| !matches!(token, DigitalInputTokenV1::GamepadButton { .. }));
        if !needs_native_hook {
            return Ok(Self { hook: None });
        }

        let hook = Hook::new();
        let held = Arc::new(Mutex::new(HashSet::<String>::new()));
        let callback = Arc::new(on_input);
        hook.run_async(move |event: &Event| {
            let Some((token, pressed, impulse)) = event_token(event) else {
                return;
            };
            let signature = token.signature();
            let direction = directions.direction_for(&token);
            let Some(direction) = direction else {
                return;
            };
            if impulse {
                callback(NativeDigitalInput {
                    direction,
                    detail: token.detail_code(),
                    apply_step: true,
                    input_active: true,
                    impulse: true,
                });
                return;
            }
            let mut held = held.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some((apply_step, input_active)) = held_transition(&mut held, signature, pressed)
            {
                callback(NativeDigitalInput {
                    direction,
                    detail: token.detail_code(),
                    apply_step,
                    input_active,
                    impulse: false,
                });
            }
        })
        .map_err(|_| CommandError::io("The native input monitor could not start."))?;
        Ok(Self { hook: Some(hook) })
    }

    pub fn stop(&self) {
        if let Some(hook) = &self.hook {
            if hook.is_running() {
                let _ = hook.stop();
            }
        }
    }
}

fn held_transition(
    held: &mut HashSet<String>,
    signature: String,
    pressed: bool,
) -> Option<(bool, bool)> {
    if pressed {
        // OS repeat generates additional press events. Only the not-held to held
        // transition advances the digital rating.
        held.insert(signature).then_some((true, true))
    } else {
        held.remove(&signature).then_some((false, !held.is_empty()))
    }
}

impl Drop for NativeInputMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn event_token(event: &Event) -> Option<(DigitalInputTokenV1, bool, bool)> {
    match event.event_type {
        EventType::KeyPressed | EventType::KeyReleased => event.keyboard.as_ref().map(|keyboard| {
            (
                DigitalInputTokenV1::Keyboard {
                    code: format!("{:?}", keyboard.key),
                },
                event.event_type == EventType::KeyPressed,
                false,
            )
        }),
        EventType::MousePressed | EventType::MouseReleased => event
            .mouse
            .as_ref()
            .and_then(|mouse| mouse.button)
            .and_then(browser_button)
            .map(|button| {
                (
                    DigitalInputTokenV1::MouseButton { button },
                    event.event_type == EventType::MousePressed,
                    false,
                )
            }),
        EventType::MouseWheel => event.wheel.as_ref().map(|wheel| {
            (
                DigitalInputTokenV1::Wheel {
                    direction: match wheel.direction {
                        ScrollDirection::Up => DirectionV1::Up,
                        ScrollDirection::Down => DirectionV1::Down,
                        ScrollDirection::Left => DirectionV1::Left,
                        ScrollDirection::Right => DirectionV1::Right,
                    },
                },
                true,
                true,
            )
        }),
        EventType::HookEnabled
        | EventType::HookDisabled
        | EventType::KeyTyped
        | EventType::MouseClicked
        | EventType::MouseMoved
        | EventType::MouseDragged => None,
    }
}

fn browser_button(button: Button) -> Option<u8> {
    match button {
        Button::Left => Some(0),
        Button::Middle => Some(1),
        Button::Right => Some(2),
        Button::Button4 => Some(3),
        Button::Button5 => Some(4),
        Button::Unknown(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monio::Key;

    #[test]
    fn physical_keys_use_browser_code_names() {
        let event = Event::key_pressed(Key::ArrowUp, 0);
        let (token, pressed, impulse) = event_token(&event).unwrap();
        assert_eq!(
            token,
            DigitalInputTokenV1::Keyboard {
                code: "ArrowUp".into()
            }
        );
        assert!(pressed);
        assert!(!impulse);
    }

    #[test]
    fn mouse_indices_match_the_browser_contract() {
        assert_eq!(browser_button(Button::Left), Some(0));
        assert_eq!(browser_button(Button::Middle), Some(1));
        assert_eq!(browser_button(Button::Right), Some(2));
    }

    #[test]
    fn character_typed_events_are_never_recorded() {
        let event = Event::key_typed(Key::KeyA, 0, 'a');
        assert!(event_token(&event).is_none());
    }

    #[test]
    fn repeats_are_ignored_and_release_never_requests_a_step() {
        let mut held = HashSet::new();
        assert_eq!(
            held_transition(&mut held, "key:ArrowUp".to_owned(), true),
            Some((true, true))
        );
        assert_eq!(
            held_transition(&mut held, "key:ArrowUp".to_owned(), true),
            None
        );
        assert_eq!(
            held_transition(&mut held, "key:ArrowUp".to_owned(), false),
            Some((false, false))
        );
        assert_eq!(
            held_transition(&mut held, "key:ArrowUp".to_owned(), false),
            None
        );
    }
}
