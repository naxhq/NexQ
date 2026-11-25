//! Text helpers shared by every feature: one token estimate, one CJK test,
//! one list of stopwords and one fence stripper, so the prompt budgets, the
//! search and the live engines agree.
//!
//! Moved here: the workspace search and chat, and `live_common` (its `is_cjk` and
//! `estimate_tokens` now come from here).
//!
//! Kept apart on purpose, because moving them would change behaviour that predates
//! the workspaces branch: `context::token_counter::count_tokens` (chars/4, no CJK:
//! the meeting budget), `ai_runs::windows::estimate_tokens` (counts Hangul and
//! switches the whole text to the CJK rate above 50%), the stopword list of
//! `live_common` (different words, 3 letters and more, tuned for topic terms).
//! `live_notes` and `live_brief` have no fence stripping of their own: their
//! tolerant JSON readers cut at the braces.

/// Han, Hiragana, Katakana (incl. extensions and half-width forms). Hangul
/// is written with spaces, so it is handled as ordinary words.
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF
        | 0x31F0..=0x31FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF
        | 0xFF66..=0xFF9F
        | 0x20000..=0x2FA1F)
}

/// Share of CJK characters among all letters and digits (0 for no letters).
pub fn cjk_ratio(text: &str) -> f32 {
    let (mut cjk, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_alphanumeric() {
            other += 1;
        }
    }
    let total = cjk + other;
    if total == 0 {
        0.0
    } else {
        cjk as f32 / total as f32
    }
}

/// True when the text is mostly CJK.
pub fn is_mostly_cjk(text: &str) -> bool {
    cjk_ratio(text) >= 0.30
}

/// Token estimate: chars/4 for most text, chars/1.5 for CJK characters.
pub fn estimate_tokens(text: &str) -> usize {
    let (mut cjk, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    ((other as f64 / 4.0) + (cjk as f64 / 1.5)).ceil() as usize
}

/// Very common words of English, German, Spanish and French (lowercase, with
/// their accents). Used only to thin a long natural-language question; a short
/// query keeps every word, and a word that is a stopword in one language and a
/// content word in another is never dropped from a short query.
const STOPWORDS: &[&str] = &[
    // English
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with", "about", "as", "is",
    "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have", "has", "had", "it", "its",
    "this", "that", "these", "those", "i", "me", "my", "we", "our", "us", "you", "your", "he", "she", "they", "them",
    "their", "what", "which", "who", "whom", "when", "where", "why", "how", "can", "could", "would", "should", "will",
    "shall", "may", "might", "must", "not", "no", "so", "than", "then", "there", "from", "into", "over", "any", "some",
    "all", "up", "out", "just", "also", "tell", "say", "said", "talk", "talked", "discuss", "discussed", "please",
    // German
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "oder", "aber", "ist",
    "sind", "war", "waren", "wird", "wurde", "wurden", "hat", "haben", "hatte", "nicht", "mit", "von", "zu", "zum",
    "zur", "im", "am", "um", "auf", "aus", "bei", "nach", "für", "über", "wie", "wo", "wann", "was", "wer", "welche",
    "welcher", "ich", "wir", "sie", "es", "auch", "noch", "nur", "dass",
    // Spanish
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "pero", "es", "son", "fue", "fueron", "ha", "han",
    "de", "del", "al", "en", "con", "por", "para", "sobre", "como", "cuál", "cuáles", "qué", "quién", "cuándo",
    "dónde", "cómo", "se", "su", "sus", "lo", "le", "les", "mi", "que", "más", "muy", "también",
    // French
    "le", "les", "une", "des", "du", "et", "ou", "mais", "est", "sont", "été", "était", "ont", "au", "aux", "dans",
    "sur", "pour", "par", "avec", "comme", "quel", "quelle", "quels", "quelles", "qui", "quoi", "quand", "où",
    "comment", "ce", "cet", "cette", "ces", "son", "sa", "ses", "je", "nous", "vous", "ils", "elles", "ne", "pas",
    "plus", "très", "aussi", "qu", "l", "d", "n", "s", "c", "j", "m", "t",
];

pub fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word)
}

/// The text inside a Markdown code fence, or the text itself when it is not
/// fenced: a leading ```` ```json ```` line and a trailing ```` ``` ```` go.
pub fn strip_code_fences(text: &str) -> String {
    let t = text.trim();
    let Some(rest) = t.strip_prefix("```") else { return t.to_string() };
    let body = match rest.find('\n') {
        Some(i) => &rest[i + 1..],
        None => rest,
    };
    body.trim_end().trim_end_matches("```").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_use_chars_over_four_and_cjk_over_one_and_a_half() {
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("日本語のテキスト"), 6);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn cjk_detection_and_ratio() {
        assert!(is_cjk('日') && is_cjk('の') && is_cjk('カ') && !is_cjk('a') && !is_cjk('한'));
        assert!(is_mostly_cjk("来月の契約更新について") && !is_mostly_cjk("Quarterly budget review"));
    }

    #[test]
    fn stopwords_cover_four_languages_and_keep_content_words() {
        for w in ["the", "der", "los", "dans", "qué", "wann"] {
            assert!(is_stopword(w), "{w}");
        }
        for w in ["budget", "vertrag", "contrato", "hirondelle", "kestrel"] {
            assert!(!is_stopword(w), "{w}");
        }
    }

    #[test]
    fn fences_are_stripped_only_when_present() {
        assert_eq!(strip_code_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fences("```\nplain\n```"), "plain");
        assert_eq!(strip_code_fences("  {\"a\":1}  "), "{\"a\":1}");
    }
}
