use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::prompt_templates;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionConfig {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub visible: bool,
    pub system_prompt: String,
    pub is_default_prompt: bool,

    pub include_transcript: bool,
    pub include_rag_chunks: bool,
    pub include_custom_instructions: bool,
    pub include_detected_question: bool,

    /// Enable provider-native web search/grounding for this action (Gemini google_search, OpenRouter :online).
    #[serde(default)]
    pub web_search: bool,

    pub transcript_window_seconds: Option<u64>,
    pub rag_top_k: Option<usize>,
    pub temperature: Option<f64>,

    pub is_built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GlobalDefaults {
    pub transcript_window_seconds: u64,
    pub rag_top_k: usize, // Legacy: retained for deserialization of old configs. Superseded by RagConfig.top_k.
    pub temperature: f64,
    pub question_detection: bool,
    pub auto_trigger: bool,
}

impl Default for GlobalDefaults {
    fn default() -> Self {
        Self {
            transcript_window_seconds: 300,
            rag_top_k: 5,
            temperature: 0.3,
            question_detection: true,
            auto_trigger: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct InstructionPresets {
    pub tone: Option<String>,
    pub format: Option<String>,
    pub length: Option<String>,
    pub opinion: Option<String>,
}

impl Default for InstructionPresets {
    fn default() -> Self {
        Self {
            tone: None,
            format: None,
            length: None,
            opinion: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct AllActionConfigs {
    pub global_defaults: GlobalDefaults,
    pub custom_instructions: String,
    pub instruction_presets: InstructionPresets,
    pub actions: HashMap<String, ActionConfig>,
}

impl Default for AllActionConfigs {
    fn default() -> Self {
        let mut actions = HashMap::new();

        actions.insert(
            "Assist".to_string(),
            ActionConfig {
                id: "Assist".to_string(),
                name: "Assist".to_string(),
                mode: "Assist".to_string(),
                visible: true,
                system_prompt: prompt_templates::ASSIST_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: true,
                include_custom_instructions: true,
                include_detected_question: true,
                web_search: false,
                transcript_window_seconds: None,
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "WhatToSay".to_string(),
            ActionConfig {
                id: "WhatToSay".to_string(),
                name: "Say".to_string(),
                mode: "WhatToSay".to_string(),
                visible: true,
                system_prompt: prompt_templates::WHAT_TO_SAY_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: true,
                include_detected_question: true,
                web_search: false,
                transcript_window_seconds: Some(60),
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "Shorten".to_string(),
            ActionConfig {
                id: "Shorten".to_string(),
                name: "Short".to_string(),
                mode: "Shorten".to_string(),
                visible: true,
                system_prompt: prompt_templates::SHORTEN_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: true,
                include_detected_question: true,
                web_search: false,
                transcript_window_seconds: Some(30),
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "FollowUp".to_string(),
            ActionConfig {
                id: "FollowUp".to_string(),
                name: "F/U".to_string(),
                mode: "FollowUp".to_string(),
                visible: true,
                system_prompt: prompt_templates::FOLLOW_UP_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: true,
                include_detected_question: false,
                web_search: false,
                transcript_window_seconds: None,
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "Recap".to_string(),
            ActionConfig {
                id: "Recap".to_string(),
                name: "Recap".to_string(),
                mode: "Recap".to_string(),
                visible: true,
                system_prompt: prompt_templates::RECAP_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: false,
                include_detected_question: false,
                web_search: false,
                transcript_window_seconds: Some(0), // 0 = all transcript
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "AskQuestion".to_string(),
            ActionConfig {
                id: "AskQuestion".to_string(),
                name: "Ask".to_string(),
                mode: "AskQuestion".to_string(),
                visible: true,
                system_prompt: prompt_templates::ASK_QUESTION_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: true,
                include_custom_instructions: true,
                include_detected_question: false,
                web_search: true,
                transcript_window_seconds: None,
                rag_top_k: None,
                temperature: None,

                is_built_in: true,
            },
        );

        actions.insert(
            "ActionItemsExtraction".to_string(),
            ActionConfig {
                id: "ActionItemsExtraction".to_string(),
                name: "Actions".to_string(),
                mode: "ActionItemsExtraction".to_string(),
                visible: false, // Internal mode — not shown in overlay action bar
                system_prompt: prompt_templates::ACTION_ITEMS_EXTRACTION_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: false,
                include_detected_question: false,
                web_search: false,
                transcript_window_seconds: Some(0), // 0 = all transcript (need full meeting)
                rag_top_k: None,
                temperature: Some(0.1), // Low temperature for structured JSON output
                is_built_in: true,
            },
        );

        actions.insert(
            "BookmarkSuggestions".to_string(),
            ActionConfig {
                id: "BookmarkSuggestions".to_string(),
                name: "Bookmarks".to_string(),
                mode: "BookmarkSuggestions".to_string(),
                visible: false, // Internal mode — not shown in overlay action bar
                system_prompt: prompt_templates::BOOKMARK_SUGGESTIONS_PROMPT.to_string(),
                is_default_prompt: true,
                include_transcript: true,
                include_rag_chunks: false,
                include_custom_instructions: false,
                include_detected_question: false,
                web_search: false,
                transcript_window_seconds: Some(0), // 0 = all transcript (need full meeting)
                rag_top_k: None,
                temperature: Some(0.1), // Low temperature for structured JSON output
                is_built_in: true,
            },
        );

        Self {
            global_defaults: GlobalDefaults::default(),
            custom_instructions: String::new(),
            instruction_presets: InstructionPresets::default(),
            actions,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A new install finds questions, and answering them stays your choice.
    #[test]
    fn new_installs_detect_questions_without_answering_them() {
        let defaults = GlobalDefaults::default();
        assert!(defaults.question_detection);
        assert!(!defaults.auto_trigger);
    }

    /// Configs saved before the setting existed: Auto-Answer off used to hide
    /// the question cards too, and now keeps them.
    #[test]
    fn saved_configs_without_question_detection_turn_it_on() {
        let defaults: GlobalDefaults = serde_json::from_str(r#"{"autoTrigger":false}"#).unwrap();
        assert!(defaults.question_detection);
        assert!(!defaults.auto_trigger);
    }
}
