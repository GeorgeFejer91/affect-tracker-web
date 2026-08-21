use crate::commands::{apply_overlay_editing, apply_overlay_geometry, show_settings};
use crate::domain::{Action, FeatureAction};
use crate::runtime::Runtime;
use monio::{Button, Event, EventType, Hook, ScrollDirection};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

fn key_name(event: &Event) -> Option<String> {
    event
        .keyboard
        .as_ref()
        .map(|keyboard| format!("{:?}", keyboard.key))
}

fn button_name(button: Button) -> String {
    format!("{button:?}")
}

fn wheel_name(direction: ScrollDirection) -> String {
    format!("{direction:?}")
}

fn trigger_action(
    app: &AppHandle,
    runtime: &Runtime,
    action: Action,
    pressed: bool,
    impulse: bool,
) {
    if action.is_directional() {
        if impulse {
            runtime.nudge(action, "global-input");
        } else {
            runtime.handle_direction(action, pressed, "global-input");
        }
        return;
    }
    if !pressed && !impulse {
        return;
    }
    match action {
        Action::Reset => runtime.reset("global-input"),
        Action::TogglePause => runtime.toggle_pause("global-input"),
        Action::ShowSettings => show_settings(app),
        Action::ToggleOverlayEditing => {
            let _ = apply_overlay_editing(app, runtime, !runtime.overlay_editing());
        }
        _ => {}
    }
}

fn trigger_feature_action(
    app: &AppHandle,
    runtime: &Runtime,
    action: FeatureAction,
    pressed: bool,
    impulse: bool,
) {
    if !pressed && !impulse {
        return;
    }
    runtime.adjust_feature(action, "global-input");
    if action.changes_size() {
        let _ = apply_overlay_geometry(app, &runtime.settings());
    }
}

fn handle_button_event(
    app: &AppHandle,
    runtime: &Runtime,
    held: &Mutex<HashSet<String>>,
    button: Button,
    pressed: bool,
) {
    let name = button_name(button);
    let token = format!("mouse:{name}");
    runtime.push_input_marker(
        "mouse",
        if pressed { "pressed" } else { "released" },
        &name,
        "",
    );
    let first_transition = if pressed {
        held.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(token.clone())
    } else {
        held.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&token);
        true
    };
    if first_transition {
        if let Some(action) = runtime.action_for_binding(&token) {
            trigger_action(app, runtime, action, pressed, false);
        } else if let Some(action) = runtime.feature_action_for_binding(&token) {
            trigger_feature_action(app, runtime, action, pressed, false);
        }
    }
}

fn handle_event(app: &AppHandle, runtime: &Runtime, held: &Mutex<HashSet<String>>, event: &Event) {
    match event.event_type {
        EventType::HookEnabled => runtime.push_input_marker("system", "hook-enabled", "", ""),
        EventType::HookDisabled => runtime.push_input_marker("system", "hook-disabled", "", ""),
        EventType::KeyPressed | EventType::KeyReleased => {
            let Some(name) = key_name(event) else { return };
            let pressed = event.event_type == EventType::KeyPressed;
            let token = format!("key:{name}");
            runtime.push_input_marker(
                "keyboard",
                if pressed { "pressed" } else { "released" },
                &name,
                "",
            );
            let first_transition = if pressed {
                held.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(token.clone())
            } else {
                held.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&token);
                true
            };
            if first_transition {
                if let Some(action) = runtime.action_for_binding(&token) {
                    trigger_action(app, runtime, action, pressed, false);
                } else if let Some(action) = runtime.feature_action_for_binding(&token) {
                    trigger_feature_action(app, runtime, action, pressed, false);
                }
            }
        }
        EventType::MousePressed | EventType::MouseReleased => {
            if let Some(button) = event.mouse.as_ref().and_then(|mouse| mouse.button) {
                handle_button_event(
                    app,
                    runtime,
                    held,
                    button,
                    event.event_type == EventType::MousePressed,
                );
            }
        }
        EventType::MouseWheel => {
            if let Some(wheel) = &event.wheel {
                let name = wheel_name(wheel.direction);
                let token = format!("wheel:{name}");
                runtime.push_input_marker("wheel", "scrolled", &name, &wheel.delta.to_string());
                if let Some(action) = runtime.action_for_binding(&token) {
                    trigger_action(app, runtime, action, true, true);
                } else if let Some(action) = runtime.feature_action_for_binding(&token) {
                    trigger_feature_action(app, runtime, action, true, true);
                }
            }
        }
        EventType::KeyTyped
        | EventType::MouseClicked
        | EventType::MouseMoved
        | EventType::MouseDragged => {}
    }
}

pub fn start(app: AppHandle, runtime: Arc<Runtime>) -> Result<(), String> {
    let hook = Hook::new();
    let callback_runtime = Arc::clone(&runtime);
    let held = Arc::new(Mutex::new(HashSet::new()));
    let callback_held = Arc::clone(&held);
    hook.run_async(move |event: &Event| {
        handle_event(&app, &callback_runtime, &callback_held, event);
    })
    .map_err(|error| format!("Global input monitoring could not start: {error}"))?;
    runtime.set_input_hook(hook);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_names_match_browser_capture_tokens() {
        assert_eq!(button_name(Button::Left), "Left");
        assert_eq!(wheel_name(ScrollDirection::Down), "Down");
    }
}
