// Saved Codex and Claude transcripts are mostly records Helm ignores: tool
// output, encrypted reasoning, progress and command logs. This scanner finds
// the lines a JavaScript reader would discard and returns positions of the
// rest. JavaScript still parses each kept line and applies every chat rule.
//
// The scanner does not validate JSON. JSON.parse rejects an invalid line and
// the reader then ignores it, so dropping or keeping it gives the same chat.
// For valid JSON the scanner must read fields exactly as JSON.parse does: the
// last duplicate key wins and escaped keys and values are decoded. A line it
// cannot follow is kept, and JSON.parse decides.

use napi::bindgen_prelude::{Buffer, Float64Array};
use napi_derive::napi;
use std::borrow::Cow;

/// The raw JSON text of a field value; None is a missing field.
type Raw<'a> = Option<&'a [u8]>;

fn skip_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// The index after the string that starts at `i`.
fn string_end(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    loop {
        i += memchr::memchr2(b'"', b'\\', b.get(i..)?)?;
        if b[i] == b'"' {
            return Some(i + 1);
        }
        i += 2;
    }
}

/// The index after the value that starts at `i`.
fn value_end(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => string_end(b, i),
        b'{' | b'[' => {
            // Valid JSON closes brackets in order, so one depth counts both kinds.
            let (mut depth, mut i) = (0usize, i);
            while i < b.len() {
                match b[i] {
                    b'"' => {
                        i = string_end(b, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        _ => {
            let end = b[i..]
                .iter()
                .position(|c| matches!(c, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r'))
                .map_or(b.len(), |n| i + n);
            (end > i).then_some(end)
        }
    }
}

/// A decoded JSON string; None for another kind of value or a bad escape.
fn decode(raw: &[u8]) -> Option<Cow<'_, str>> {
    let inner = raw.strip_prefix(b"\"")?.strip_suffix(b"\"")?;
    if !inner.contains(&b'\\') {
        // Invalid UTF-8 cannot equal a field name. JavaScript sees U+FFFD.
        return Some(Cow::Borrowed(std::str::from_utf8(inner).unwrap_or("\u{fffd}")));
    }
    serde_json::from_slice::<String>(raw).ok().map(Cow::Owned)
}

fn name_of(key: &[u8], names: &[&str]) -> Result<Option<usize>, ()> {
    let inner = &key[1..key.len() - 1];
    if let Some(n) = names.iter().position(|name| inner == name.as_bytes()) {
        return Ok(Some(n));
    }
    if !inner.contains(&b'\\') {
        return Ok(None);
    }
    let key = decode(key).ok_or(())?;
    Ok(names.iter().position(|name| *name == key))
}

/// Walk the object that starts at `start` in one pass. `on(n, i)` reads the
/// value of `names[n]` at `i` and returns its end; other values are skipped.
/// As in JSON.parse, a later duplicate key replaces an earlier value, so `on`
/// overwrites. Err means the scanner cannot follow the text.
fn object(b: &[u8], start: usize, names: &[&str], mut on: impl FnMut(usize, usize) -> Result<usize, ()>) -> Result<usize, ()> {
    let mut i = skip_space(b, start + 1);
    if b.get(i) == Some(&b'}') {
        return Ok(i + 1);
    }
    loop {
        if b.get(i) != Some(&b'"') {
            return Err(());
        }
        let key_end = string_end(b, i).ok_or(())?;
        let name = name_of(&b[i..key_end], names)?;
        i = skip_space(b, key_end);
        if b.get(i) != Some(&b':') {
            return Err(());
        }
        i = skip_space(b, i + 1);
        let end = match name {
            Some(n) => on(n, i)?,
            None => value_end(b, i).ok_or(())?,
        };
        i = skip_space(b, end);
        match b.get(i) {
            Some(b',') => i = skip_space(b, i + 1),
            Some(b'}') => return Ok(i + 1),
            _ => return Err(()),
        }
    }
}

/// Walk the array that starts at `start`; `on(i)` returns each element's end.
fn array(b: &[u8], start: usize, mut on: impl FnMut(usize) -> Result<usize, ()>) -> Result<usize, ()> {
    let mut i = skip_space(b, start + 1);
    if b.get(i) == Some(&b']') {
        return Ok(i + 1);
    }
    loop {
        i = skip_space(b, on(i)?);
        match b.get(i) {
            Some(b',') => i = skip_space(b, i + 1),
            Some(b']') => return Ok(i + 1),
            _ => return Err(()),
        }
    }
}

/// The value at `i` and its end.
fn span(b: &[u8], i: usize) -> Result<(&[u8], usize), ()> {
    let end = value_end(b, i).ok_or(())?;
    Ok((&b[i..end], end))
}

/// The named fields of the value at `i`, or None when it is not an object,
/// like a JavaScript property read on a primitive or array. Also its end.
fn fields<'a, const N: usize>(b: &'a [u8], i: usize, names: [&str; N]) -> Result<(Option<[Raw<'a>; N]>, usize), ()> {
    if b.get(i) != Some(&b'{') {
        return Ok((None, value_end(b, i).ok_or(())?));
    }
    let mut out = [None; N];
    let end = object(b, i, &names, |n, j| {
        let (value, end) = span(b, j)?;
        out[n] = Some(value);
        Ok(end)
    })?;
    Ok((Some(out), end))
}

/// Walk a whole line, which must hold one object and nothing else.
fn record(line: &[u8], names: &[&str], on: impl FnMut(usize, usize) -> Result<usize, ()>) -> Result<(), ()> {
    let start = skip_space(line, 0);
    if line.get(start) != Some(&b'{') {
        return Err(());
    }
    let end = object(line, start, names, on)?;
    if skip_space(line, end) != line.len() {
        return Err(());
    }
    Ok(())
}

/// The named top-level fields of a line.
fn top<'a, const N: usize>(line: &'a [u8], names: [&str; N]) -> Result<[Raw<'a>; N], ()> {
    let mut out = [None; N];
    record(line, &names, |n, i| {
        let (value, end) = span(line, i)?;
        out[n] = Some(value);
        Ok(end)
    })?;
    Ok(out)
}

/// Top-level `type` plus the named fields of the object in `inner`.
fn top_and_inner<'a, const N: usize>(line: &'a [u8], inner: &str, names: [&str; N]) -> Result<(Raw<'a>, Option<[Raw<'a>; N]>), ()> {
    let (mut kind, mut fields_in) = (None, None);
    record(line, &["type", inner], |n, i| {
        if n == 0 {
            let (value, end) = span(line, i)?;
            kind = Some(value);
            Ok(end)
        } else {
            let (value, end) = fields(line, i, names)?;
            fields_in = value;
            Ok(end)
        }
    })?;
    Ok((kind, fields_in))
}

/// Whether a Claude message's content would give a chat message. A string is
/// the text; an empty one is none. Without text or a tool call, a content
/// array adds nothing: tool results and thinking alone are not a message.
fn claude_content(b: &[u8], i: usize) -> Result<(bool, usize), ()> {
    match b.get(i) {
        Some(b'"') => {
            let end = string_end(b, i).ok_or(())?;
            Ok((end - i > 2, end))
        }
        Some(b'[') => {
            let mut any = false;
            let end = array(b, i, |j| {
                let (block, end) = fields(b, j, ["type"])?;
                if let Some([kind]) = block {
                    any |= is(kind, &["text", "output_text", "input_text", "tool_use"])?;
                }
                Ok(end)
            })?;
            Ok((any, end))
        }
        _ => Ok((false, value_end(b, i).ok_or(())?)),
    }
}

fn is(raw: Raw<'_>, values: &[&str]) -> Result<bool, ()> {
    let Some(raw) = raw else { return Ok(false) };
    if raw[0] != b'"' {
        return Ok(false);
    }
    Ok(values.contains(&decode(raw).ok_or(())?.as_ref()))
}

/// JavaScript truthiness of a JSON value; a missing field is undefined.
fn truthy(raw: Raw<'_>) -> bool {
    let Some(raw) = raw else { return false };
    match raw[0] {
        b'f' | b'n' => false,
        b'"' => raw.len() > 2,
        b'-' | b'0'..=b'9' => std::str::from_utf8(raw)
            .ok()
            .and_then(|n| n.parse::<f64>().ok())
            .map_or(true, |n| n != 0.0),
        _ => true,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rule {
    CodexMessages,
    ClaudeMessages,
    ClaudeSidechain,
    CodexState,
    ClaudeUsage,
    CodexActivity,
}

impl Rule {
    fn from(code: u32) -> Option<Rule> {
        use Rule::*;
        [CodexMessages, ClaudeMessages, ClaudeSidechain, CodexState, ClaudeUsage, CodexActivity]
            .get(code as usize)
            .copied()
    }
}

const CODEX_TOOLS: [&str; 4] = ["custom_tool_call", "function_call", "local_shell_call", "web_search_call"];

/// Ok(false) only when the JavaScript reader would certainly ignore the line.
fn wanted(line: &[u8], rule: Rule) -> Result<bool, ()> {
    if line.iter().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0b | 0x0c)) {
        return Ok(false);
    }
    match rule {
        Rule::CodexMessages => {
            let (kind, payload) = top_and_inner(line, "payload", ["type", "role"])?;
            if !is(kind, &["response_item"])? {
                return Ok(false);
            }
            let Some([kind, role]) = payload else { return Ok(false) };
            Ok(is(kind, &CODEX_TOOLS)? || is(kind, &["message"])? && is(role, &["user", "assistant"])?)
        }
        Rule::ClaudeMessages | Rule::ClaudeSidechain => {
            let (mut kind, mut sidechain, mut content) = (None, None, false);
            record(line, &["type", "isSidechain", "message"], |n, i| match n {
                0 => span(line, i).map(|(value, end)| { kind = Some(value); end }),
                1 => span(line, i).map(|(value, end)| { sidechain = Some(value); end }),
                _ if line[i] == b'{' => {
                    content = false;
                    object(line, i, &["content"], |_, j| {
                        let (wanted, end) = claude_content(line, j)?;
                        content = wanted;
                        Ok(end)
                    })
                }
                _ => span(line, i).map(|(_, end)| { content = false; end }),
            })?;
            Ok(is(kind, &["user", "assistant"])? && truthy(sidechain) == (rule == Rule::ClaudeSidechain) && content)
        }
        Rule::CodexState => {
            let (kind, payload) = top_and_inner(line, "payload", ["type"])?;
            if is(kind, &["session_meta", "turn_context"])? {
                return Ok(true);
            }
            let Some([inner]) = payload else { return Ok(false) };
            Ok(is(kind, &["event_msg"])? && is(inner, &["thread_settings_applied", "token_count"])?)
        }
        Rule::ClaudeUsage => {
            let [kind, message] = top(line, ["type", "message"])?;
            Ok(is(kind, &["assistant"])? && truthy(message))
        }
        Rule::CodexActivity => {
            let (kind, payload) = top_and_inner(line, "payload", ["type", "role", "channel"])?;
            let Some([inner, role, channel]) = payload else { return Ok(false) };
            if is(kind, &["event_msg"])? {
                return is(inner, &["task_started", "turn_started", "user_message", "task_complete",
                    "task_completed", "turn_complete", "turn_aborted"]);
            }
            Ok(is(kind, &["response_item"])? && is(inner, &["message"])? && is(role, &["assistant"])? && is(channel, &["final"])?)
        }
    }
}

/// Start and end byte pairs of lines to parse, in file order. Lines end at
/// "\n". With `split_cr`, "\r\n" and a lone "\r" also end a line, as in
/// Node's readline.
pub fn select(bytes: &[u8], rule: Option<Rule>, split_cr: bool) -> Vec<f64> {
    let mut rows = Vec::new();
    let mut start = 0;
    while start <= bytes.len() {
        let rest = &bytes[start..];
        let found = if split_cr { memchr::memchr2(b'\n', b'\r', rest) } else { memchr::memchr(b'\n', rest) };
        let end = found.map_or(bytes.len(), |n| start + n);
        if end > start && rule.map_or(true, |rule| wanted(&bytes[start..end], rule).unwrap_or(true)) {
            rows.extend([start as f64, end as f64]);
        }
        match found {
            None => break,
            Some(_) if bytes[end] == b'\r' && bytes.get(end + 1) == Some(&b'\n') => start = end + 2,
            Some(_) => start = end + 1,
        }
    }
    rows
}

/// Scan transcript bytes already read by Helm. Rule codes follow
/// transcript-native.js. An unknown rule keeps every line.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn transcript_lines(bytes: Buffer, rule: u32, split_cr: bool) -> Float64Array {
    Float64Array::new(select(bytes.as_ref(), Rule::from(rule), split_cr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keeps(rule: Rule, line: &str) -> bool {
        !select(line.as_bytes(), Some(rule), false).is_empty()
    }

    #[test]
    fn codex_keeps_messages_and_tools_only() {
        let rule = Rule::CodexMessages;
        assert!(keeps(rule, r#"{"type":"response_item","payload":{"type":"message","role":"user"}}"#));
        assert!(keeps(rule, r#"{"type":"response_item","payload":{"type":"function_call"}}"#));
        assert!(keeps(rule, r#"{"type":"response_item","payload":{"type":"message","role":"assistant"}}"#));
        assert!(!keeps(rule, r#"{"type":"response_item","payload":{"type":"function_call_output","output":"x"}}"#));
        assert!(!keeps(rule, r#"{"type":"response_item","payload":{"type":"message","role":"developer"}}"#));
        assert!(!keeps(rule, r#"{"type":"event_msg","payload":{"type":"message","role":"user"}}"#));
        assert!(!keeps(rule, r#"{"type":"response_item","payload":[1]}"#));
        assert!(!keeps(rule, r#"{"payload":{"type":"message","role":"user"}}"#));
        // The last duplicate wins, as in JSON.parse.
        assert!(keeps(rule, r#"{"type":"event_msg","type":"response_item","payload":{"type":"message","role":"user"}}"#));
        assert!(!keeps(rule, r#"{"type":"response_item","type":"event_msg","payload":{"type":"message","role":"user"}}"#));
        assert!(!keeps(rule, r#"{"type":"response_item","payload":{"type":"message","role":"user"},"payload":7}"#));
        // Lines the scanner cannot follow go to JSON.parse.
        assert!(keeps(rule, r#"{"type":"response_item","payload":{"type":"message","role":"\ud800"}}"#));
        assert!(keeps(rule, r#"{"type":"event_msg"} x"#));
        assert!(keeps(rule, r#"{"type":"response_item","payload":{"type":"x"}"#));
        assert!(keeps(rule, "null"));
        assert!(keeps(rule, r#"["response_item"]"#));
    }

    #[test]
    fn claude_drops_tool_results_thinking_and_other_chats() {
        let rule = Rule::ClaudeMessages;
        assert!(keeps(rule, r#"{"type":"user","message":{"content":"hi"}}"#));
        assert!(keeps(rule, r#"{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"tool_use"}]}}"#));
        assert!(!keeps(rule, r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"x"}]}]}}"#));
        assert!(!keeps(rule, r#"{"type":"assistant","message":{"content":[{"type":"thinking"},null,["text"],7]}}"#));
        assert!(!keeps(rule, r#"{"type":"user","message":{"content":""}}"#));
        assert!(!keeps(rule, r#"{"type":"user","isSidechain":1,"message":{"content":"hi"}}"#));
        assert!(keeps(rule, r#"{"type":"user","isSidechain":-0.0,"message":{"content":"hi"}}"#));
        assert!(keeps(Rule::ClaudeSidechain, r#"{"type":"user","isSidechain":"no","message":{"content":"hi"}}"#));
        assert!(!keeps(rule, r#"{"type":"progress","message":{"content":"hi"}}"#));
        assert!(!keeps(rule, r#"{"type":"user","message":"hi"}"#));
        assert!(keeps(rule, r#"{"type":"user","message":{"content":[{"type":"x","type":"text"}]}}"#));
        assert!(!keeps(rule, r#"{"type":"user","message":{"content":[{"type":"text","type":"x"}]}}"#));
        assert!(keeps(rule, r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"a \" ] } \\"},{"type":"text"}]}}"#));
    }

    #[test]
    fn state_usage_and_activity_keep_only_their_records() {
        let state = Rule::from(3).unwrap();
        assert!(keeps(state, r#"{"type":"turn_context","payload":7}"#));
        assert!(keeps(state, r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#));
        assert!(!keeps(state, r#"{"type":"event_msg","payload":{"type":"exec_command_end","aggregated_output":"x"}}"#));
        assert!(!keeps(state, r#"{"type":"response_item","payload":{"type":"token_count"}}"#));
        let usage = Rule::from(4).unwrap();
        assert!(keeps(usage, r#"{"type":"assistant","message":{"usage":{}}}"#));
        assert!(!keeps(usage, r#"{"type":"assistant","message":null}"#));
        assert!(!keeps(usage, r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#));
        let activity = Rule::from(5).unwrap();
        assert!(keeps(activity, r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#));
        assert!(keeps(activity, r#"{"type":"response_item","payload":{"type":"message","role":"assistant","channel":"final"}}"#));
        assert!(!keeps(activity, r#"{"type":"response_item","payload":{"type":"message","role":"assistant"}}"#));
        assert!(!keeps(activity, r#"{"type":"event_msg","payload":{"type":"token_count"}}"#));
        // An unknown rule keeps every line.
        assert_eq!(select(b"{}\n \nx", Rule::from(99), false), vec![0.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn lines_follow_each_reader() {
        let body = "{\"type\":\"x\"}\r{\"type\":\"user\",\"message\":{\"content\":\"اردو 😀\"}}\r\n\n  \n{bad";
        let rows = select(body.as_bytes(), Some(Rule::ClaudeMessages), true);
        let second = body.find("\r\n").unwrap();
        assert_eq!(rows, vec![13.0, second as f64, (body.len() - 4) as f64, body.len() as f64]);
        // Without readline's rule the first line holds both records and is not JSON.
        let rows = select(body.as_bytes(), Some(Rule::ClaudeMessages), false);
        assert_eq!(rows, vec![0.0, (second + 1) as f64, (body.len() - 4) as f64, body.len() as f64]);
    }
}
