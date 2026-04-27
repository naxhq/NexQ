use std::collections::HashMap;
use std::path::Path;

type CharMap = HashMap<u8, char>;

/// Extract text from a PDF.
/// 1) pdf_extract (fast, handles most PDFs)
/// 2) lopdf fallback with full font encoding resolution (handles Type1 + custom encoding vectors)
pub fn extract_text_from_pdf(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("PDF file not found: {}", file_path));
    }

    match pdf_extract::extract_text(path) {
        Ok(text) => {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
            log::warn!("pdf_extract returned empty for '{}', trying lopdf fallback", file_path);
        }
        Err(e) => {
            log::warn!("pdf_extract failed for '{}': {} — trying lopdf fallback", file_path, e);
        }
    }

    extract_with_lopdf(file_path).and_then(|text| {
        if text.trim().is_empty() {
            Err(
                "PDF has no extractable text. It may be a scanned/image-based PDF \
                 (no text layer) or use an unsupported font encoding. \
                 Try converting to .txt first."
                    .to_string(),
            )
        } else {
            Ok(text)
        }
    })
}

// ── lopdf fallback ────────────────────────────────────────────────────────────

fn extract_with_lopdf(file_path: &str) -> Result<String, String> {
    use lopdf::content::Content;
    use lopdf::Document;

    let doc = Document::load(file_path)
        .map_err(|e| format!("lopdf failed to load PDF: {}", e))?;

    let mut full_text = String::new();

    for page_id in doc.page_iter() {
        let font_maps = get_page_font_maps(&doc, page_id);

        let content_bytes = match doc.get_page_content(page_id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let content = match Content::decode(&content_bytes) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut in_text = false;
        let mut current_font: Option<String> = None;
        let mut page_text = String::new();

        for op in &content.operations {
            match op.operator.as_str() {
                "BT" => { in_text = true; }
                "ET" => { in_text = false; page_text.push('\n'); }
                "Tf" if in_text => {
                    if let Some(lopdf::Object::Name(name)) = op.operands.first() {
                        current_font = Some(String::from_utf8_lossy(name).to_string());
                    }
                }
                "Tj" if in_text => {
                    if let Some(lopdf::Object::String(bytes, _)) = op.operands.first() {
                        let map = current_font.as_deref().and_then(|f| font_maps.get(f));
                        page_text.push_str(&decode_bytes(bytes, map));
                    }
                }
                "TJ" if in_text => {
                    if let Some(lopdf::Object::Array(arr)) = op.operands.first() {
                        let map = current_font.as_deref().and_then(|f| font_maps.get(f));
                        for item in arr {
                            if let lopdf::Object::String(bytes, _) = item {
                                page_text.push_str(&decode_bytes(bytes, map));
                            }
                            // numeric kern values — skip
                        }
                    }
                }
                "Td" | "TD" | "T*" if in_text => {
                    if !page_text.ends_with('\n') { page_text.push(' '); }
                }
                "Tm" if in_text => {
                    if !page_text.ends_with('\n') { page_text.push('\n'); }
                }
                _ => {}
            }
        }

        full_text.push_str(&page_text);
        full_text.push('\n');
    }

    Ok(full_text.trim().to_string())
}

// ── Font map building ─────────────────────────────────────────────────────────

fn get_page_font_maps(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> HashMap<String, CharMap> {
    let mut maps: HashMap<String, CharMap> = HashMap::new();

    let (resources, _) = doc.get_page_resources(page_id);
    let resources = match resources {
        Some(r) => r,
        None => return maps,
    };

    let font_dict = match resources.get(b"Font") {
        Ok(lopdf::Object::Dictionary(d)) => d.clone(),
        Ok(lopdf::Object::Reference(id)) => match doc.get_object(*id) {
            Ok(lopdf::Object::Dictionary(d)) => d.clone(),
            _ => return maps,
        },
        _ => return maps,
    };

    for (key, val) in &font_dict {
        let font_name = String::from_utf8_lossy(key).to_string();
        let font_id = match val {
            lopdf::Object::Reference(id) => *id,
            _ => continue,
        };
        if let Ok(char_map) = build_font_char_map(doc, font_id) {
            maps.insert(font_name, char_map);
        }
    }

    maps
}

fn build_font_char_map(doc: &lopdf::Document, font_id: lopdf::ObjectId) -> Result<CharMap, ()> {
    let font_obj = doc.get_object(font_id).map_err(|_| ())?;
    let font_dict = match font_obj {
        lopdf::Object::Dictionary(d) => d,
        lopdf::Object::Stream(s) => &s.dict,
        _ => return Err(()),
    };

    // ToUnicode CMap — most reliable source
    if let Ok(tu_ref) = font_dict.get(b"ToUnicode") {
        if let Some(map) = parse_to_unicode_cmap(doc, tu_ref) {
            return Ok(map);
        }
    }

    // /Encoding dictionary or name
    match font_dict.get(b"Encoding") {
        Ok(enc) => build_encoding_map(doc, enc),
        Err(_) => Ok(win_ansi_map()),
    }
}

// ── ToUnicode CMap parser ─────────────────────────────────────────────────────

fn parse_to_unicode_cmap(doc: &lopdf::Document, obj: &lopdf::Object) -> Option<CharMap> {
    let id = match obj {
        lopdf::Object::Reference(id) => *id,
        _ => return None,
    };
    let stream = match doc.get_object(id) {
        Ok(lopdf::Object::Stream(s)) => s,
        _ => return None,
    };
    let data = stream.decompressed_content().ok()?;
    parse_cmap_text(&String::from_utf8_lossy(&data))
}

fn parse_cmap_text(cmap: &str) -> Option<CharMap> {
    let mut map = CharMap::new();
    let mut in_section = false;
    let mut is_range = false;

    for line in cmap.lines() {
        let line = line.trim();
        if line.contains("beginbfchar") { in_section = true; is_range = false; continue; }
        if line.contains("beginbfrange") { in_section = true; is_range = true; continue; }
        if line.contains("endbfchar") || line.contains("endbfrange") {
            in_section = false; continue;
        }
        if !in_section || !line.starts_with('<') { continue; }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if !is_range && parts.len() == 2 {
            if let (Some(src), Some(dst)) = (parse_hex_byte(parts[0]), parse_hex_u32(parts[1])) {
                if let Some(ch) = char::from_u32(dst) { map.insert(src, ch); }
            }
        } else if is_range && parts.len() == 3 {
            if let (Some(start), Some(end), Some(dst)) = (
                parse_hex_byte(parts[0]), parse_hex_byte(parts[1]), parse_hex_u32(parts[2]),
            ) {
                for i in 0..=(end.wrapping_sub(start)) {
                    if let Some(ch) = char::from_u32(dst + i as u32) {
                        map.insert(start.wrapping_add(i), ch);
                    }
                }
            }
        }
    }

    if map.is_empty() { None } else { Some(map) }
}

fn parse_hex_byte(s: &str) -> Option<u8> {
    u8::from_str_radix(s.strip_prefix('<')?.strip_suffix('>')?, 16).ok()
}

fn parse_hex_u32(s: &str) -> Option<u32> {
    u32::from_str_radix(s.strip_prefix('<')?.strip_suffix('>')?, 16).ok()
}

// ── /Encoding resolver ────────────────────────────────────────────────────────

fn build_encoding_map(doc: &lopdf::Document, obj: &lopdf::Object) -> Result<CharMap, ()> {
    let resolved: &lopdf::Object = match obj {
        lopdf::Object::Reference(id) => doc.get_object(*id).map_err(|_| ())?,
        other => other,
    };

    match resolved {
        lopdf::Object::Name(name) => Ok(named_encoding_map(name)),
        lopdf::Object::Dictionary(enc_dict) => {
            let mut map = match enc_dict.get(b"BaseEncoding") {
                Ok(lopdf::Object::Name(name)) => named_encoding_map(name),
                _ => win_ansi_map(),
            };
            if let Ok(lopdf::Object::Array(diffs)) = enc_dict.get(b"Differences") {
                let mut code: u8 = 0;
                for item in diffs {
                    match item {
                        lopdf::Object::Integer(n) => { code = *n as u8; }
                        lopdf::Object::Name(glyph) => {
                            let name = String::from_utf8_lossy(glyph);
                            if let Some(ch) = glyph_name_to_char(&name) {
                                map.insert(code, ch);
                            }
                            code = code.wrapping_add(1);
                        }
                        _ => {}
                    }
                }
            }
            Ok(map)
        }
        _ => Ok(win_ansi_map()),
    }
}

fn named_encoding_map(name: &[u8]) -> CharMap {
    match name {
        b"MacRomanEncoding" => mac_roman_map(),
        b"StandardEncoding" => standard_map(),
        _ => win_ansi_map(), // WinAnsiEncoding and unknown → Windows-1252
    }
}

// ── Byte decoding ─────────────────────────────────────────────────────────────

fn decode_bytes(bytes: &[u8], char_map: Option<&CharMap>) -> String {
    // UTF-16BE with BOM
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let utf16: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| u16::from_be_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
            .collect();
        if let Ok(s) = String::from_utf16(&utf16) { return s; }
    }

    if let Some(map) = char_map {
        return bytes.iter().filter_map(|b| map.get(b)).collect();
    }

    if let Ok(s) = std::str::from_utf8(bytes) { return s.to_string(); }
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    decoded.into_owned()
}

// ── Standard encoding tables ──────────────────────────────────────────────────

fn win_ansi_map() -> CharMap {
    let mut map = CharMap::new();
    for b in 0x20u8..=0x7Eu8 { map.insert(b, b as char); }
    let ext: &[(u8, char)] = &[
        (0x80,'€'),(0x82,'‚'),(0x83,'ƒ'),(0x84,'„'),(0x85,'…'),(0x86,'†'),(0x87,'‡'),
        (0x88,'ˆ'),(0x89,'‰'),(0x8A,'Š'),(0x8B,'‹'),(0x8C,'Œ'),(0x8E,'Ž'),
        (0x91,'\u{2018}'),(0x92,'\u{2019}'),(0x93,'\u{201C}'),(0x94,'\u{201D}'),
        (0x95,'•'),(0x96,'–'),(0x97,'—'),(0x98,'˜'),(0x99,'™'),(0x9A,'š'),
        (0x9B,'›'),(0x9C,'œ'),(0x9E,'ž'),(0x9F,'Ÿ'),
        (0xA0,'\u{00A0}'),(0xA1,'¡'),(0xA2,'¢'),(0xA3,'£'),(0xA4,'¤'),(0xA5,'¥'),
        (0xA6,'¦'),(0xA7,'§'),(0xA8,'¨'),(0xA9,'©'),(0xAA,'ª'),(0xAB,'«'),
        (0xAC,'¬'),(0xAD,'\u{00AD}'),(0xAE,'®'),(0xAF,'¯'),(0xB0,'°'),(0xB1,'±'),
        (0xB2,'²'),(0xB3,'³'),(0xB4,'´'),(0xB5,'µ'),(0xB6,'¶'),(0xB7,'·'),
        (0xB8,'¸'),(0xB9,'¹'),(0xBA,'º'),(0xBB,'»'),(0xBC,'¼'),(0xBD,'½'),
        (0xBE,'¾'),(0xBF,'¿'),
        (0xC0,'À'),(0xC1,'Á'),(0xC2,'Â'),(0xC3,'Ã'),(0xC4,'Ä'),(0xC5,'Å'),
        (0xC6,'Æ'),(0xC7,'Ç'),(0xC8,'È'),(0xC9,'É'),(0xCA,'Ê'),(0xCB,'Ë'),
        (0xCC,'Ì'),(0xCD,'Í'),(0xCE,'Î'),(0xCF,'Ï'),(0xD0,'Ð'),(0xD1,'Ñ'),
        (0xD2,'Ò'),(0xD3,'Ó'),(0xD4,'Ô'),(0xD5,'Õ'),(0xD6,'Ö'),(0xD7,'×'),
        (0xD8,'Ø'),(0xD9,'Ù'),(0xDA,'Ú'),(0xDB,'Û'),(0xDC,'Ü'),(0xDD,'Ý'),
        (0xDE,'Þ'),(0xDF,'ß'),
        (0xE0,'à'),(0xE1,'á'),(0xE2,'â'),(0xE3,'ã'),(0xE4,'ä'),(0xE5,'å'),
        (0xE6,'æ'),(0xE7,'ç'),(0xE8,'è'),(0xE9,'é'),(0xEA,'ê'),(0xEB,'ë'),
        (0xEC,'ì'),(0xED,'í'),(0xEE,'î'),(0xEF,'ï'),(0xF0,'ð'),(0xF1,'ñ'),
        (0xF2,'ò'),(0xF3,'ó'),(0xF4,'ô'),(0xF5,'õ'),(0xF6,'ö'),(0xF7,'÷'),
        (0xF8,'ø'),(0xF9,'ù'),(0xFA,'ú'),(0xFB,'û'),(0xFC,'ü'),(0xFD,'ý'),
        (0xFE,'þ'),(0xFF,'ÿ'),
    ];
    for &(b, c) in ext { map.insert(b, c); }
    map
}

fn mac_roman_map() -> CharMap {
    let mut map = CharMap::new();
    for b in 0x20u8..=0x7Eu8 { map.insert(b, b as char); }
    let ext: &[(u8, char)] = &[
        (0x80,'Ä'),(0x81,'Å'),(0x82,'Ç'),(0x83,'É'),(0x84,'Ñ'),(0x85,'Ö'),(0x86,'Ü'),
        (0x87,'á'),(0x88,'à'),(0x89,'â'),(0x8A,'ä'),(0x8B,'ã'),(0x8C,'å'),(0x8D,'ç'),
        (0x8E,'é'),(0x8F,'è'),(0x90,'ê'),(0x91,'ë'),(0x92,'í'),(0x93,'ì'),(0x94,'î'),
        (0x95,'ï'),(0x96,'ñ'),(0x97,'ó'),(0x98,'ò'),(0x99,'ô'),(0x9A,'ö'),(0x9B,'ú'),
        (0x9C,'ù'),(0x9D,'û'),(0x9E,'ü'),(0x9F,'†'),(0xA0,'°'),(0xA1,'¢'),(0xA2,'£'),
        (0xA3,'§'),(0xA4,'•'),(0xA5,'¶'),(0xA6,'ß'),(0xA7,'®'),(0xA8,'©'),(0xA9,'™'),
        (0xAA,'´'),(0xAB,'¨'),(0xAC,'\u{2260}'),(0xAD,'Æ'),(0xAE,'Ø'),(0xAF,'\u{221E}'),
        (0xB0,'±'),(0xB1,'\u{2264}'),(0xB2,'\u{2265}'),(0xB3,'¥'),(0xB4,'µ'),
        (0xB5,'\u{2202}'),(0xB6,'\u{2211}'),(0xB7,'\u{220F}'),(0xB8,'π'),
        (0xB9,'\u{222B}'),(0xBA,'ª'),(0xBB,'º'),(0xBC,'Ω'),(0xBD,'æ'),(0xBE,'ø'),
        (0xBF,'¿'),(0xC0,'¡'),(0xC1,'¬'),(0xC2,'\u{0192}'),(0xC3,'«'),(0xC4,'»'),
        (0xC5,'\u{2026}'),(0xC6,'\u{00A0}'),(0xC7,'À'),(0xC8,'Ã'),(0xC9,'Õ'),
        (0xCA,'Œ'),(0xCB,'œ'),(0xCC,'–'),(0xCD,'—'),(0xCE,'\u{201C}'),(0xCF,'\u{201D}'),
        (0xD0,'\u{2018}'),(0xD1,'\u{2019}'),(0xD2,'÷'),(0xD3,'\u{25CA}'),(0xD4,'ÿ'),
        (0xD5,'Ÿ'),(0xD6,'\u{2044}'),(0xD7,'€'),(0xD8,'‹'),(0xD9,'›'),(0xDA,'fi'),
        (0xDB,'fl'),(0xDC,'‡'),(0xDD,'·'),(0xDE,'‚'),(0xDF,'„'),(0xE0,'‰'),
        (0xE1,'Â'),(0xE2,'Ê'),(0xE3,'Á'),(0xE4,'Ë'),(0xE5,'È'),(0xE6,'Í'),(0xE7,'Î'),
        (0xE8,'Ï'),(0xE9,'Ì'),(0xEA,'Ó'),(0xEB,'Ô'),(0xED,'Ò'),(0xEE,'Ú'),(0xEF,'Û'),
        (0xF0,'Ù'),(0xF1,'ı'),(0xF2,'ˆ'),(0xF3,'˜'),(0xF4,'¯'),(0xF5,'˘'),(0xF6,'˙'),
        (0xF7,'˚'),(0xF8,'¸'),(0xF9,'˝'),(0xFA,'˛'),(0xFB,'ˇ'),
    ];
    for &(b, c) in ext { map.insert(b, c); }
    map
}

fn standard_map() -> CharMap {
    // Adobe StandardEncoding — ASCII printables, common punctuation
    let mut map = CharMap::new();
    for b in 0x20u8..=0x7Eu8 { map.insert(b, b as char); }
    let ext: &[(u8, char)] = &[
        (0xA1,'Æ'),(0xA2,'æ'),(0xA3,'°'),(0xA4,'/'),(0xA5,'Ø'),(0xA6,'ø'),
        (0xA8,'\u{201C}'),(0xA9,'\u{201D}'),(0xAA,'\u{2019}'),(0xAB,'fi'),(0xAC,'fl'),
        (0xAE,'\u{2013}'),(0xAF,'\u{2014}'),(0xB0,'\u{2018}'),(0xB1,'†'),
        (0xB4,'•'),(0xB6,'¶'),(0xB7,'§'),(0xBB,'–'),(0xBC,'\u{2022}'),
        (0xBF,'¿'),(0xC0,'`'),(0xC1,'´'),(0xC2,'^'),(0xC3,'~'),(0xC4,'¯'),
        (0xC5,'˘'),(0xC6,'˙'),(0xC7,'¨'),(0xC9,'˚'),(0xCA,'\u{00B8}'),
        (0xCB,'\u{00B4}'),(0xCD,'˝'),(0xCE,'\u{02DB}'),(0xCF,'ˇ'),
        (0xD0,'—'),(0xE1,'Æ'),(0xE3,'ª'),(0xE8,'Ł'),(0xE9,'Ø'),(0xEA,'Œ'),
        (0xEB,'º'),(0xF1,'æ'),(0xF3,'ı'),(0xF8,'ł'),(0xF9,'ø'),(0xFA,'œ'),
        (0xFB,'ß'),
    ];
    for &(b, c) in ext { map.insert(b, c); }
    map
}

// ── Adobe Glyph List (Latin + Spanish subset) ─────────────────────────────────

fn glyph_name_to_char(name: &str) -> Option<char> {
    // uniXXXX / uXXXX convention
    if let Some(hex) = name.strip_prefix("uni") {
        if let Ok(n) = u32::from_str_radix(hex, 16) { return char::from_u32(n); }
    }
    if let Some(hex) = name.strip_prefix('u') {
        if hex.len() >= 4 {
            if let Ok(n) = u32::from_str_radix(hex, 16) { return char::from_u32(n); }
        }
    }

    Some(match name {
        "space"=>' ',"exclam"=>'!',"quotedbl"=>'"',"numbersign"=>'#',"dollar"=>'$',
        "percent"=>'%',"ampersand"=>'&',"quotesingle"=>'\'', "quoteright"=>'\'',
        "parenleft"=>'(',"parenright"=>')',"asterisk"=>'*',"plus"=>'+',
        "comma"=>',',"hyphen"|"minus"=>'-',"period"=>'.',"slash"=>'/',
        "zero"=>'0',"one"=>'1',"two"=>'2',"three"=>'3',"four"=>'4',
        "five"=>'5',"six"=>'6',"seven"=>'7',"eight"=>'8',"nine"=>'9',
        "colon"=>':',"semicolon"=>';',"less"=>'<',"equal"=>'=',"greater"=>'>',
        "question"=>'?',"at"=>'@',
        "A"=>'A',"B"=>'B',"C"=>'C',"D"=>'D',"E"=>'E',"F"=>'F',"G"=>'G',
        "H"=>'H',"I"=>'I',"J"=>'J',"K"=>'K',"L"=>'L',"M"=>'M',"N"=>'N',
        "O"=>'O',"P"=>'P',"Q"=>'Q',"R"=>'R',"S"=>'S',"T"=>'T',"U"=>'U',
        "V"=>'V',"W"=>'W',"X"=>'X',"Y"=>'Y',"Z"=>'Z',
        "bracketleft"=>'[',"backslash"=>'\\',"bracketright"=>']',
        "asciicircum"=>'^',"underscore"=>'_',"grave"|"quoteleft"=>'`',
        "a"=>'a',"b"=>'b',"c"=>'c',"d"=>'d',"e"=>'e',"f"=>'f',"g"=>'g',
        "h"=>'h',"i"=>'i',"j"=>'j',"k"=>'k',"l"=>'l',"m"=>'m',"n"=>'n',
        "o"=>'o',"p"=>'p',"q"=>'q',"r"=>'r',"s"=>'s',"t"=>'t',"u"=>'u',
        "v"=>'v',"w"=>'w',"x"=>'x',"y"=>'y',"z"=>'z',
        "braceleft"=>'{',"bar"=>'|',"braceright"=>'}',"asciitilde"=>'~',
        // Latin extended — full Spanish set
        "Agrave"=>'À',"Aacute"=>'Á',"Acircumflex"=>'Â',"Atilde"=>'Ã',
        "Adieresis"=>'Ä',"Aring"=>'Å',"AE"=>'Æ',"Ccedilla"=>'Ç',
        "Egrave"=>'È',"Eacute"=>'É',"Ecircumflex"=>'Ê',"Edieresis"=>'Ë',
        "Igrave"=>'Ì',"Iacute"=>'Í',"Icircumflex"=>'Î',"Idieresis"=>'Ï',
        "Eth"=>'Ð',"Ntilde"=>'Ñ',"Ograve"=>'Ò',"Oacute"=>'Ó',
        "Ocircumflex"=>'Ô',"Otilde"=>'Õ',"Odieresis"=>'Ö',"multiply"=>'×',
        "Oslash"=>'Ø',"Ugrave"=>'Ù',"Uacute"=>'Ú',"Ucircumflex"=>'Û',
        "Udieresis"=>'Ü',"Yacute"=>'Ý',"Thorn"=>'Þ',"germandbls"|"ssharp"=>'ß',
        "agrave"=>'à',"aacute"=>'á',"acircumflex"=>'â',"atilde"=>'ã',
        "adieresis"=>'ä',"aring"=>'å',"ae"=>'æ',"ccedilla"=>'ç',
        "egrave"=>'è',"eacute"=>'é',"ecircumflex"=>'ê',"edieresis"=>'ë',
        "igrave"=>'ì',"iacute"=>'í',"icircumflex"=>'î',"idieresis"=>'ï',
        "eth"=>'ð',"ntilde"=>'ñ',"ograve"=>'ò',"oacute"=>'ó',
        "ocircumflex"=>'ô',"otilde"=>'õ',"odieresis"=>'ö',"divide"=>'÷',
        "oslash"=>'ø',"ugrave"=>'ù',"uacute"=>'ú',"ucircumflex"=>'û',
        "udieresis"=>'ü',"yacute"=>'ý',"thorn"=>'þ',"ydieresis"=>'ÿ',
        // Typography
        "endash"=>'–',"emdash"=>'—',
        "quotedblleft"=>'\u{201C}',"quotedblright"=>'\u{201D}',
        "quotesinglbase"=>'‚',"quotedblbase"=>'„',
        "ellipsis"=>'…',"dagger"=>'†',"daggerdbl"=>'‡',"bullet"=>'•',
        "perthousand"=>'‰',"guilsinglleft"=>'‹',"guilsinglright"=>'›',
        "guillemotleft"=>'«',"guillemotright"=>'»',
        "exclamdown"=>'¡',"questiondown"=>'¿',
        "cent"=>'¢',"sterling"=>'£',"currency"=>'¤',"yen"=>'¥',
        "section"=>'§',"copyright"=>'©',"ordfeminine"=>'ª',
        "registered"=>'®',"degree"=>'°',"plusminus"=>'±',
        "twosuperior"=>'²',"threesuperior"=>'³',"mu"=>'µ',"paragraph"=>'¶',
        "periodcentered"=>'·',"ordmasculine"=>'º',
        "onequarter"=>'¼',"onehalf"=>'½',"threequarters"=>'¾',
        "fi"=>'fi',"fl"=>'fl',"ff"=>'f',"ffi"=>'f',"ffl"=>'f',
        "lslash"=>'ł',"Lslash"=>'Ł',"oe"=>'œ',"OE"=>'Œ',
        "scaron"=>'š',"Scaron"=>'Š',"zcaron"=>'ž',"Zcaron"=>'Ž',
        "trademark"=>'™',"Euro"=>'€',
        _ => return None,
    })
}
