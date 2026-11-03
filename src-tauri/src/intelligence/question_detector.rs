// Sub-PRD 6: Question detection
// Layer 1: Regex (sentences ending ?, interrogative words)
// Layer 2: Interview-specific contextual patterns

use serde::{Deserialize, Serialize};

/// A detected question from the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedQuestion {
    pub text: String,
    pub confidence: f64,
    pub timestamp_ms: u64,
    pub source: String,
}

/// Detects questions in transcript text using two layers:
/// - Layer 1: Regex patterns (question marks, interrogative words)
/// - Layer 2: Interview-specific contextual patterns
pub struct QuestionDetector;

/// Interrogative words that commonly start questions.
const INTERROGATIVE_STARTERS: &[&str] = &[
    "what", "why", "how", "when", "where", "who", "which",
    "can", "could", "would", "should",
    "do", "does", "is", "are", "will", "have", "has",
    "tell",
];

/// Common Chinese question words, including simplified and traditional forms.
const CHINESE_QUESTION_WORDS: &[&str] = &[
    "什么", "什麼", "怎么", "怎麼", "为什么", "為什麼",
    "哪", "谁", "誰", "多少", "如何",
];

/// Phrases where a Chinese question word means "any" or "no matter" rather
/// than asking (没什么问题 "no problem", 无论如何 "no matter what").
const CHINESE_NON_QUESTION_PHRASES: &[&str] = &[
    "没什么", "沒什麼", "什么都", "什麼都", "什么也", "什麼也",
    "不怎么", "不怎麼", "哪怕", "谁都", "誰都", "谁也", "誰也",
    "无论", "無論", "不管", "多多少少",
];

/// Japanese question endings. A bare か also ends ordinary words
/// (静か "quiet", 確か "surely", とか "and so on"), so it isn't enough alone.
const JAPANESE_QUESTION_ENDINGS: &[&str] = &[
    "ですか", "ますか", "ませんか", "でしたか", "ましたか",
    "でしょうか", "ましょうか", "のか", "ないか",
];

/// A tag on its own ("Right?", "You know?") asks nothing the AI could answer.
const TAG_QUESTIONS: &[&str] = &[
    "right", "okay", "ok", "yeah", "yep", "yes", "no", "nope", "sure", "correct", "true", "really",
    "agreed", "alright", "all right", "huh", "hmm", "hm", "eh", "see", "you see", "you know",
    "isn't it", "sorry", "pardon", "hello", "cool", "good",
];

/// Words that can come before a tag ("So, right?").
const TAG_LEAD_INS: &[&str] = &[
    "and", "so", "but", "well", "oh", "um", "uh", "okay", "ok", "yeah", "yes", "no",
];

/// Interview-specific patterns that indicate a question or prompt.
const INTERVIEW_PATTERNS: &[&str] = &[
    "walk me through",
    "describe a time",
    "tell me about",
    "what would you do",
    "how do you handle",
    "give me an example",
    "explain how",
    "what's your experience with",
    "what is your experience with",
    "can you walk me through",
    "can you describe",
    "can you explain",
    "can you tell me",
    "talk about a time",
    "share an example",
    "how would you",
    "how have you",
    "what approach would you",
    "what's your approach to",
    "what is your approach to",
];

impl QuestionDetector {
    pub fn new() -> Self {
        Self
    }

    /// Detect questions in the given text.
    /// Returns a list of detected questions with confidence scores.
    pub fn detect_questions(&self, text: &str, timestamp_ms: u64, source: &str) -> Vec<DetectedQuestion> {
        let mut questions: Vec<DetectedQuestion> = Vec::new();

        // Split text into sentences
        let sentences = split_sentences(text);

        for sentence in &sentences {
            let trimmed = sentence.trim();
            // Short questions such as "谁？" and "Why?" are valid, but
            // punctuation-only fragments are not.
            if !trimmed.chars().any(char::is_alphanumeric) || is_tag_question(trimmed) {
                continue;
            }

            let mut confidence: f64 = 0.0;

            // Layer 1: Check for question mark
            if trimmed.ends_with(['?', '？']) {
                confidence = 0.95;
            }

            // STT may omit question marks or use a full stop instead.
            if is_cjk_question(trimmed) {
                confidence = confidence.max(0.6);
            }

            // Layer 1: Check for interrogative word starters
            if confidence < 0.5 {
                let lower = trimmed.to_lowercase();
                let first_word = lower.split_whitespace().next().unwrap_or("");
                if INTERROGATIVE_STARTERS.contains(&first_word) {
                    // Interrogative word at start without question mark
                    confidence = confidence.max(0.6);
                }
            }

            // Layer 2: Check for interview-specific patterns
            let lower = trimmed.to_lowercase();
            for pattern in INTERVIEW_PATTERNS {
                if lower.contains(pattern) {
                    // Interview patterns are strong signals
                    confidence = confidence.max(0.85);
                    break;
                }
            }

            // Only include if confidence is above threshold
            if confidence >= 0.5 {
                questions.push(DetectedQuestion {
                    text: trimmed.to_string(),
                    confidence,
                    timestamp_ms,
                    source: source.to_string(),
                });
            }
        }

        questions
    }
}

/// Whether a sentence is only a tag, with or without words leading into it.
fn is_tag_question(sentence: &str) -> bool {
    let lower = sentence.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | '.' | '?' | '？' | '!' | '…'))
        .filter(|word| !word.is_empty())
        .collect();
    let lead_ins = words
        .iter()
        .take(words.len().saturating_sub(1))
        .take_while(|word| TAG_LEAD_INS.contains(word))
        .count();
    TAG_QUESTIONS.contains(&words[lead_ins..].join(" ").as_str())
}

/// Chinese and Japanese question signals for a sentence without a question
/// mark. Question particles count only at the end of the sentence; Chinese
/// question words need no whitespace boundaries. Auto-Trigger answers detected
/// questions, so suggestions such as 我们开始吧 ("let's start") are left out.
fn is_cjk_question(sentence: &str) -> bool {
    let body = sentence.trim_end_matches(['.', '!', '。', '！', '…']);
    body.ends_with(['吗', '嗎', '呢'])
        || JAPANESE_QUESTION_ENDINGS.iter().any(|ending| body.ends_with(ending))
        || (CHINESE_QUESTION_WORDS.iter().any(|word| body.contains(word))
            && !CHINESE_NON_QUESTION_PHRASES.iter().any(|phrase| body.contains(phrase)))
}

/// Split text into sentences using common sentence terminators.
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '?' | '!' | '。' | '？' | '！' | '\n') {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current.clear();
        }
    }

    // Don't forget the last sentence fragment (may not end with punctuation)
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }

    sentences
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_full_width_and_short_questions() {
        for text in ["计划完成了？", "準備できました？", "谁？", "Why?"] {
            let questions = QuestionDetector::new().detect_questions(text, 42, "Them");
            assert_eq!(questions.len(), 1, "{text}");
            assert_eq!(questions[0].text, text);
            assert_eq!(questions[0].confidence, 0.95);
            assert_eq!(questions[0].timestamp_ms, 42);
            assert_eq!(questions[0].source, "Them");
        }
    }

    #[test]
    fn skips_a_bare_tag_but_keeps_short_questions() {
        for text in ["Right?", "right?", "Okay?", "Yeah, right?", "So, right?", "You know?", "Isn't it?", "Really?"] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "Them");
            assert!(questions.is_empty(), "{text}");
        }
        for text in ["Why?", "Is that right?", "Right now?", "And you?"] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "Them");
            assert_eq!(questions.len(), 1, "{text}");
        }
    }

    #[test]
    fn a_trailing_tag_leaves_the_question_before_it() {
        let questions = QuestionDetector::new().detect_questions(
            "Is that what you were thinking about? Right?", 0, "Them",
        );
        assert_eq!(
            questions.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            ["Is that what you were thinking about?"]
        );
    }

    #[test]
    fn detects_chinese_questions_without_question_marks() {
        for text in [
            "准备好了吗", "準備好了嗎。", "你的计划呢",
            "这是什么", "這是什麼", "这个问题怎么解决", "這個問題怎麼解決",
            "为什么需要重试", "為什麼需要重試", "哪天发布", "选哪个方案",
            "谁来负责", "誰來負責", "需要多少时间", "如何开始",
        ] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "You");
            assert_eq!(questions.len(), 1, "{text}");
            assert_eq!(questions[0].confidence, 0.6, "{text}");
        }
    }

    #[test]
    fn detects_japanese_question_endings() {
        for text in ["準備できましたか", "いつ始めますか。", "これでよいですか！", "一緒に行きませんか", "どうでしょうか"] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "Them");
            assert_eq!(questions.len(), 1, "{text}");
            assert_eq!(questions[0].confidence, 0.6, "{text}");
        }
    }

    #[test]
    fn separates_cjk_sentences_and_unpunctuated_lines() {
        let questions = QuestionDetector::new().detect_questions(
            "今天讨论进度。计划完成了吗？谢谢！\n準備できましたか\nCan we start?", 7, "Them",
        );
        assert_eq!(
            questions.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            ["计划完成了吗？", "準備できましたか", "Can we start?"]
        );
    }

    #[test]
    fn preserves_english_confidence_and_ignores_statements() {
        for (text, confidence) in [
            ("What is the plan?", 0.95),
            ("How can we start", 0.6),
            ("Tell me about your last project", 0.85),
        ] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "Them");
            assert_eq!(questions.len(), 1, "{text}");
            assert_eq!(questions[0].confidence, confidence);
        }
        for text in [
            "", "   ", "！？??...", "会议结束了。谢谢大家！", "会議は終了しました。", "The meeting is over.",
            // Suggestions and indefinite uses of question words are statements.
            "我们开始吧", "好，那就这样吧。", "没什么问题", "我什么都可以", "无论如何都要按时完成",
            "不管怎么样，我们明天发布", "哪怕晚一点也没关系",
            // Words that merely end in か.
            "とても静か", "確か", "コーヒーとか",
        ] {
            assert!(QuestionDetector::new().detect_questions(text, 0, "Them").is_empty(), "{text}");
        }
    }
}
