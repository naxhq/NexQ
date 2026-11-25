//! Script-aware text helpers: CJK detection, unit counting (Latin words and
//! CJK characters), token estimates and sentence splitting.

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

/// True when the text is mostly CJK (the trigram index is used for it).
pub fn is_mostly_cjk(text: &str) -> bool {
    cjk_ratio(text) >= 0.30
}

/// Byte ranges of "atoms": one CJK character, or a run of non-CJK,
/// non-space characters with its trailing space. The flag says whether the
/// atom counts as a unit (it holds a letter or digit).
pub fn atoms(text: &str) -> Vec<(usize, usize, bool)> {
    let mut out = Vec::new();
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if is_cjk(c) {
            out.push((i, i + c.len_utf8(), true));
            continue;
        }
        let mut end = i + c.len_utf8();
        if c.is_whitespace() {
            while let Some(&(j, d)) = it.peek() {
                if d.is_whitespace() {
                    end = j + d.len_utf8();
                    it.next();
                } else {
                    break;
                }
            }
            out.push((i, end, false));
            continue;
        }
        let mut counts = c.is_alphanumeric();
        while let Some(&(j, d)) = it.peek() {
            if d.is_whitespace() || is_cjk(d) {
                break;
            }
            if d.is_alphanumeric() {
                counts = true;
            }
            end = j + d.len_utf8();
            it.next();
        }
        while let Some(&(j, d)) = it.peek() {
            if d.is_whitespace() {
                end = j + d.len_utf8();
                it.next();
            } else {
                break;
            }
        }
        out.push((i, end, counts));
    }
    out
}

/// Words for Latin text, characters for CJK. Passage sizes and word-count
/// triggers use this.
pub fn unit_count(text: &str) -> usize {
    atoms(text).iter().filter(|a| a.2).count()
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

/// Split into pieces of at most `max_units` units, cutting between atoms.
pub fn split_units(text: &str, max_units: usize) -> Vec<String> {
    let max_units = max_units.max(1);
    let mut out = Vec::new();
    let (mut start, mut units) = (0usize, 0usize);
    let mut last_end = 0usize;
    for (a, b, counts) in atoms(text) {
        if counts && units == max_units {
            out.push(text[start..last_end].trim().to_string());
            start = a;
            units = 0;
        }
        if counts {
            units += 1;
        }
        last_end = b;
    }
    if start < text.len() {
        out.push(text[start..].trim().to_string());
    }
    out.retain(|s| !s.is_empty());
    out
}

/// Split into sentences, keeping each terminator. A Latin `.`, `!` or `?`
/// ends a sentence only when followed by whitespace; CJK terminators and
/// newlines always do.
pub fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let end_here = match c {
            '\n' | '。' | '！' | '？' => true,
            '.' | '!' | '?' => it.peek().map_or(true, |&(_, n)| n.is_whitespace()),
            _ => false,
        };
        if end_here {
            let mut end = i + c.len_utf8();
            while let Some(&(j, d)) = it.peek() {
                if d == '」' || d == '』' || d == '"' || d == '\'' || d == ')' || d == '）' {
                    end = j + d.len_utf8();
                    it.next();
                } else {
                    break;
                }
            }
            let piece = &text[start..end];
            if !piece.trim().is_empty() {
                out.push(piece);
            }
            start = end;
        }
    }
    if start < text.len() && !text[start..].trim().is_empty() {
        out.push(&text[start..]);
    }
    out
}

/// Pack text into chunks of at most `max_units` units, keeping paragraphs
/// and sentences whole where possible. A tiny trailing chunk is merged into
/// the previous one when the result stays within 25% slack.
pub fn chunk_text(text: &str, max_units: usize) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if unit_count(para) <= max_units {
            blocks.push(para.to_string());
            continue;
        }
        for s in split_sentences(para) {
            let s = s.trim();
            if s.is_empty() {
                continue;
            }
            if unit_count(s) <= max_units {
                blocks.push(s.to_string());
            } else {
                blocks.extend(split_units(s, max_units));
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    let (mut cur, mut cur_units) = (String::new(), 0usize);
    for b in blocks {
        let u = unit_count(&b);
        if cur_units > 0 && cur_units + u > max_units {
            out.push(std::mem::take(&mut cur));
            cur_units = 0;
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&b);
        cur_units += u;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.len() >= 2 {
        let last_u = unit_count(&out[out.len() - 1]);
        let prev_u = unit_count(&out[out.len() - 2]);
        if last_u < max_units / 5 && prev_u + last_u <= max_units + max_units / 4 {
            let last = out.pop().unwrap();
            let prev = out.last_mut().unwrap();
            prev.push('\n');
            prev.push_str(&last);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_count_words_and_cjk_chars() {
        assert_eq!(unit_count("hello big world"), 3);
        assert_eq!(unit_count("東京で会議"), 5);
        assert_eq!(unit_count("deploy 東京 now"), 4);
        assert_eq!(unit_count("  ...  "), 0);
    }

    #[test]
    fn tokens_use_chars_over_four_and_cjk_over_one_and_a_half() {
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("日本語のテキスト"), 6); // 8 / 1.5 = 5.33 -> 6
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn ratio_and_mostly_cjk() {
        assert!(is_mostly_cjk("来月の契約更新について"));
        assert!(!is_mostly_cjk("Quarterly review of the budget"));
        assert!(is_mostly_cjk("会议 about 预算和合同的安排"));
    }

    #[test]
    fn split_units_respects_max_and_never_loses_text() {
        let text = (0..50).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let parts = split_units(&text, 12);
        assert_eq!(parts.len(), 5);
        assert!(parts.iter().all(|p| unit_count(p) <= 12));
        assert_eq!(parts.join(" "), text);
        let jp = "あ".repeat(100);
        let p = split_units(&jp, 30);
        assert_eq!(p.len(), 4);
        assert_eq!(p.concat(), jp);
    }

    #[test]
    fn sentences_split_on_latin_and_cjk_terminators() {
        let s = split_sentences("Hello there. Version 2.5 ships! 次は来週です。よろしく。");
        assert_eq!(s.len(), 4, "{s:?}");
        assert!(s[1].contains("2.5"));
    }

    #[test]
    fn chunking_keeps_chunks_near_the_cap() {
        let para = "This is a sentence about the plan. ".repeat(60);
        let chunks = chunk_text(&para, 100);
        assert!(chunks.len() >= 3);
        assert!(chunks.iter().all(|c| unit_count(c) <= 125));
    }
}
