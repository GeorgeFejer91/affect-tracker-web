mod support;

use affect_tracker_study_core::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use support::{draft_study, published_study, run_configuration};

#[test]
fn fixture_round_trips_and_publishes() {
    let draft = draft_study();
    draft.validate_draft().expect("draft must validate");
    assert!(draft.protocol_hash.is_none());

    let published = draft.published().expect("draft must publish");
    published
        .validate_published()
        .expect("published study must validate");
    assert_eq!(
        published.protocol_hash,
        Some(protocol_hash(&published).unwrap())
    );

    let json = serde_json::to_string_pretty(&published).unwrap();
    let decoded: StudyDefinitionV1 = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, published);
}

#[test]
fn face_flubber_is_an_instruction_presentation_variant() {
    let study = draft_study();
    let comparison = &study.sections[0].trials[0].blocks[0];
    assert!(matches!(
        comparison,
        StudyBlockV1::Instruction {
            presentation: InstructionPresentationV1::FaceFlubberComparison,
            ..
        }
    ));
    let value = serde_json::to_value(comparison).unwrap();
    assert_eq!(value["type"], "instruction");
    assert_eq!(value["presentation"], "faceFlubberComparison");
    assert_eq!(value["blockId"], "intro-comparison");
    assert!(value.get("stimulus").is_none());
    assert!(value.get("phase").is_none());
    assert!(study
        .required_runtime_capabilities()
        .contains(&PlatformCapabilityV1::FaceFlubberComparison));
}

#[test]
fn trial_condition_fixture_is_flat_typed_and_questionnaire_anchored() {
    let study = draft_study();
    let condition = study.sections[2].trials[1]
        .run_if
        .as_ref()
        .expect("condition-b must carry the branching fixture");
    assert!(matches!(
        condition,
        TrialRunConditionV1::Equals {
            questionnaire_block_id,
            item_id,
            value: TrialConditionEqualityValueV1::SingleChoice { option_id },
        } if questionnaire_block_id == "preflight-form"
            && item_id == "handedness"
            && option_id == "right"
    ));
    let value = serde_json::to_value(condition).unwrap();
    assert_eq!(value["operator"], "equals");
    assert_eq!(value["questionnaireBlockId"], "preflight-form");
    assert_eq!(value["itemId"], "handedness");
    assert_eq!(value["value"]["type"], "singleChoice");
    assert!(value.get("conditions").is_none());
    assert!(value.get("then").is_none());
}

#[test]
fn unknown_fields_are_rejected_at_root_and_nested_variants() {
    let mut root: Value = serde_json::from_str(include_str!("../fixtures/study-v1.json")).unwrap();
    root.as_object_mut()
        .unwrap()
        .insert("surprise".to_owned(), json!(true));
    assert!(serde_json::from_value::<StudyDefinitionV1>(root).is_err());

    let mut nested: Value =
        serde_json::from_str(include_str!("../fixtures/study-v1.json")).unwrap();
    nested["sections"][0]["trials"][0]["blocks"][0]["independentPhase"] = json!(1.0);
    assert!(serde_json::from_value::<StudyDefinitionV1>(nested).is_err());

    let mut item: Value = serde_json::from_str(include_str!("../fixtures/study-v1.json")).unwrap();
    item["questionnaires"][0]["items"][0]["freeText"] = json!("forbidden");
    assert!(serde_json::from_value::<StudyDefinitionV1>(item).is_err());

    let mut condition: Value =
        serde_json::from_str(include_str!("../fixtures/study-v1.json")).unwrap();
    condition["sections"][2]["trials"][1]["runIf"]["and"] = json!([]);
    assert!(serde_json::from_value::<StudyDefinitionV1>(condition).is_err());

    let mut arbitrary_operator: Value =
        serde_json::from_str(include_str!("../fixtures/study-v1.json")).unwrap();
    arbitrary_operator["sections"][2]["trials"][1]["runIf"]["operator"] = json!("script");
    assert!(serde_json::from_value::<StudyDefinitionV1>(arbitrary_operator).is_err());
}

#[test]
fn trial_conditions_reject_self_forward_ambiguous_and_optional_sources() {
    let mut same_section = draft_study();
    same_section.sections[0].trials[0].run_if = Some(TrialRunConditionV1::Equals {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "handedness".to_owned(),
        value: TrialConditionEqualityValueV1::SingleChoice {
            option_id: "right".to_owned(),
        },
    });
    assert_eq!(
        same_section.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut forward = draft_study();
    forward.sections[3].trials[0].blocks.insert(
        0,
        StudyBlockV1::Questionnaire {
            block_id: "late-form".to_owned(),
            questionnaire_id: "preflight".to_owned(),
        },
    );
    forward.sections[2].trials[1].run_if = Some(TrialRunConditionV1::Equals {
        questionnaire_block_id: "late-form".to_owned(),
        item_id: "handedness".to_owned(),
        value: TrialConditionEqualityValueV1::SingleChoice {
            option_id: "right".to_owned(),
        },
    });
    assert_eq!(
        forward.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut missing_block = draft_study();
    if let Some(TrialRunConditionV1::Equals {
        questionnaire_block_id,
        ..
    }) = &mut missing_block.sections[2].trials[1].run_if
    {
        *questionnaire_block_id = "unknown-form".to_owned();
    }
    assert_eq!(
        missing_block.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::MissingReference
    );

    let mut optional_item = draft_study();
    if let Some(TrialRunConditionV1::Equals { item_id, value, .. }) =
        &mut optional_item.sections[2].trials[1].run_if
    {
        *item_id = "comfort".to_owned();
        *value = TrialConditionEqualityValueV1::Vas { value: 72.5 };
    }
    assert_eq!(
        optional_item.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );
}

#[test]
fn trial_conditions_reject_randomized_or_conditional_source_trials() {
    let mut randomized_source = draft_study();
    randomized_source.sections[0].order_policy = OrderPolicyV1::SeededShuffle;
    assert_eq!(
        randomized_source.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut conditional_source = draft_study();
    conditional_source.sections[1].order_policy = OrderPolicyV1::Fixed;
    conditional_source.sections[1].trials[0]
        .blocks
        .push(StudyBlockV1::Questionnaire {
            block_id: "conditional-source-form".to_owned(),
            questionnaire_id: "preflight".to_owned(),
        });
    conditional_source.sections[1].trials[0].run_if = Some(TrialRunConditionV1::Equals {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "handedness".to_owned(),
        value: TrialConditionEqualityValueV1::SingleChoice {
            option_id: "right".to_owned(),
        },
    });
    if let Some(TrialRunConditionV1::Equals {
        questionnaire_block_id,
        ..
    }) = &mut conditional_source.sections[2].trials[1].run_if
    {
        *questionnaire_block_id = "conditional-source-form".to_owned();
    }
    assert_eq!(
        conditional_source.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );
}

#[test]
fn trial_condition_operator_and_literal_must_match_the_source_item() {
    let mut mismatched = draft_study();
    if let Some(TrialRunConditionV1::Equals { value, .. }) =
        &mut mismatched.sections[2].trials[1].run_if
    {
        *value = TrialConditionEqualityValueV1::Numeric { value: 34.0 };
    }
    assert_eq!(
        mismatched.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut contains_scalar = draft_study();
    contains_scalar.sections[2].trials[1].run_if = Some(TrialRunConditionV1::Contains {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "handedness".to_owned(),
        option_id: "right".to_owned(),
    });
    assert_eq!(
        contains_scalar.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut unknown_option = draft_study();
    if let Some(TrialRunConditionV1::Equals {
        value: TrialConditionEqualityValueV1::SingleChoice { option_id },
        ..
    }) = &mut unknown_option.sections[2].trials[1].run_if
    {
        *option_id = "ambidextrous".to_owned();
    }
    assert_eq!(
        unknown_option.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::MissingReference
    );
}

#[test]
fn required_completion_block_trial_must_be_unconditional() {
    let mut study = draft_study();
    assert!(study.completion_policy.require_completion_block);
    assert!(matches!(
        study.sections[3].trials[0].blocks[0],
        StudyBlockV1::Completion { .. }
    ));
    assert!(study.sections[3].trials[0].run_if.is_none());

    study.sections[3].trials[0].run_if = Some(TrialRunConditionV1::Equals {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "handedness".to_owned(),
        value: TrialConditionEqualityValueV1::SingleChoice {
            option_id: "right".to_owned(),
        },
    });

    let error = study.validate_draft().unwrap_err();
    assert_eq!(error.code, CoreErrorCodeV1::InvalidValue);
    assert_eq!(error.path, "study.sections[3].trials[0].runIf");
    assert_eq!(
        error.message,
        "trial containing a required completion block must be unconditional"
    );
}

#[test]
fn acknowledgement_condition_rejects_the_uncommittable_false_literal() {
    let condition = |acknowledged| TrialRunConditionV1::Equals {
        questionnaire_block_id: "preflight-form".to_owned(),
        item_id: "consent".to_owned(),
        value: TrialConditionEqualityValueV1::Acknowledgement { acknowledged },
    };

    let mut unreachable = draft_study();
    unreachable.sections[2].trials[1].run_if = Some(condition(false));
    let error = unreachable.validate_draft().unwrap_err();
    assert_eq!(error.code, CoreErrorCodeV1::InvalidValue);
    assert_eq!(
        error.path,
        "study.sections[2].trials[1].runIf.value.acknowledged"
    );
    assert_eq!(
        error.message,
        "must be true because a required acknowledgement cannot commit false"
    );

    let mut reachable = draft_study();
    reachable.sections[2].trials[1].run_if = Some(condition(true));
    reachable
        .validate_draft()
        .expect("a true required-acknowledgement condition is reachable");
}

#[test]
fn invalid_references_duplicates_and_ranges_fail_closed() {
    let mut duplicate = draft_study();
    duplicate.sections[1].trials[0].blocks[0] = duplicate.sections[0].trials[0].blocks[0].clone();
    let error = duplicate.validate_draft().unwrap_err();
    assert_eq!(error.code, CoreErrorCodeV1::DuplicateId);

    let mut missing_media = draft_study();
    if let StudyBlockV1::Video { source, .. } = &mut missing_media.sections[0].trials[0].blocks[1] {
        *source = MediaSourceV1::ContentAsset {
            asset_id: "does-not-exist".to_owned(),
            clip: None,
        };
    }
    let error = missing_media.validate_draft().unwrap_err();
    assert_eq!(error.code, CoreErrorCodeV1::MissingReference);

    let mut invalid_clip = draft_study();
    invalid_clip.media[0].default_clip = Some(MediaClipV1 {
        start_ms: 100,
        end_ms: 100,
    });
    assert_eq!(
        invalid_clip.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut invalid_visual = draft_study();
    invalid_visual.pinned_settings.visual.opacity = 1.01;
    assert_eq!(
        invalid_visual.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut zero_break = draft_study();
    if let StudyBlockV1::Break {
        minimum_duration_ms,
        ..
    } = &mut zero_break.sections[2].trials[2].blocks[0]
    {
        *minimum_duration_ms = Some(0);
    }
    assert_eq!(
        zero_break.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut nonterminal_completion = draft_study();
    nonterminal_completion.sections[0].trials[0].blocks[0] = StudyBlockV1::Completion {
        block_id: "premature-completion".to_owned(),
        content: "Not actually finished.".to_owned(),
    };
    assert_eq!(
        nonterminal_completion.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );
}

#[test]
fn published_hash_detects_every_content_change() {
    let published = published_study();
    let mut changed = published.clone();
    changed.title.push('!');
    let error = changed.validate_published().unwrap_err();
    assert_eq!(error.code, CoreErrorCodeV1::HashMismatch);

    let republished = changed.published().unwrap();
    assert_ne!(republished.protocol_hash, published.protocol_hash);
}

#[test]
fn run_configuration_requires_exact_randomization_and_capabilities() {
    let study = published_study();
    let configuration = run_configuration();
    configuration.validate_for(&study).unwrap();

    let mut missing_seed = configuration.clone();
    missing_seed.random_seed = None;
    assert_eq!(
        missing_seed.validate_for(&study).unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut invalid_group = configuration.clone();
    invalid_group.counterbalance_group = Some(7);
    assert_eq!(
        invalid_group.validate_for(&study).unwrap_err().code,
        CoreErrorCodeV1::InvalidValue
    );

    let mut missing_capability = configuration;
    missing_capability
        .platform
        .capabilities
        .retain(|capability| *capability != PlatformCapabilityV1::FaceFlubberComparison);
    assert_eq!(
        missing_capability.validate_for(&study).unwrap_err().code,
        CoreErrorCodeV1::CapabilityMissing
    );
}

#[test]
fn questionnaire_catalog_is_closed_and_ids_are_unique() {
    let study = draft_study();
    let questionnaire = &study.questionnaires[0];
    let types: HashSet<&'static str> = questionnaire
        .items
        .iter()
        .map(|item| match item {
            QuestionnaireItemV1::Acknowledgement { .. } => "acknowledgement",
            QuestionnaireItemV1::SingleChoice { .. } => "singleChoice",
            QuestionnaireItemV1::MultipleChoice { .. } => "multipleChoice",
            QuestionnaireItemV1::Likert { .. } => "likert",
            QuestionnaireItemV1::Vas { .. } => "vas",
            QuestionnaireItemV1::Numeric { .. } => "numeric",
            QuestionnaireItemV1::Affect2d { .. } => "affect2d",
        })
        .collect();
    assert_eq!(types.len(), 7);
    assert!(!types.contains("freeText"));

    let mut duplicate_item = study;
    let duplicate = duplicate_item.questionnaires[0].items[0].clone();
    duplicate_item.questionnaires[0].items.push(duplicate);
    assert_eq!(
        duplicate_item.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::DuplicateId
    );
}

#[test]
fn schema_versions_are_exact() {
    let mut study = draft_study();
    study.version = 2;
    assert_eq!(
        study.validate_draft().unwrap_err().code,
        CoreErrorCodeV1::InvalidSchema
    );

    let mut config = run_configuration();
    config.schema = "similar-but-not-equal".to_owned();
    assert_eq!(
        config.validate_for(&published_study()).unwrap_err().code,
        CoreErrorCodeV1::InvalidSchema
    );
}

#[test]
fn action_and_event_fixtures_pin_browser_field_names_and_sequence_origin() {
    let action: StudyActionV1 =
        serde_json::from_str(include_str!("../fixtures/study-action-v1.json")).unwrap();
    action.validate_shape().unwrap();
    assert!(matches!(action.command, StudyCommandV1::Prepare));
    assert_eq!(action.expected_revision, 0);

    let event: RunEventV1 =
        serde_json::from_str(include_str!("../fixtures/run-event-v1.json")).unwrap();
    assert_eq!(event.sequence, 1);
    assert_eq!(event.block_id.as_deref(), Some("intro-comparison"));
    assert!(matches!(event.payload, RunEventPayloadV1::Prepared));

    let action_value: Value = serde_json::to_value(action).unwrap();
    assert_eq!(action_value["command"]["type"], "prepare");
    assert_eq!(action_value["precondition"]["expectedPhase"], "created");
    assert!(action_value["precondition"]
        .get("expectedBlockId")
        .is_none());

    let event_value: Value = serde_json::to_value(event).unwrap();
    assert_eq!(event_value["runId"], "run-fixture-001");
    assert_eq!(event_value["sequence"], 1);
}
