use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(deserializer).map(Some)
}

// Borrow only search fields. Serde validates the remaining JSON without making
// strings for tool payloads. Duplicate search fields and damaged rows go back
// to JSON.parse, which owns recovery and JavaScript coercion rules.
#[derive(Deserialize)]
struct Event<'a> {
    #[serde(default, deserialize_with = "present", borrow)]
    seq: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow, rename = "type")]
    kind: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow)]
    id: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow)]
    at: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow)]
    text: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow)]
    local: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow)]
    wake: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present", borrow, rename = "kind")]
    item_kind: Option<&'a RawValue>,
}

fn extract(bytes: &[u8]) -> String {
    let mut out = String::from("[");
    let mut start = 0;
    loop {
        let newline = memchr::memchr(b'\n', &bytes[start..]).map(|n| start + n);
        let end = newline.unwrap_or(bytes.len());
        if end > start {
            if out.len() > 1 {
                out.push(',');
            }
            let row = &bytes[start..end];
            let event = if row.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{') {
                serde_json::from_slice::<Event>(row).ok().filter(|e| {
                    // Object IDs can throw during JavaScript string coercion.
                    // Let the original reader preserve exactly when that occurs.
                    !e.id.is_some_and(|id| id.get().starts_with(['{', '[']))
                })
            } else {
                None
            };
            if let Some(e) = event {
                out.push_str("[{");
                let mut first = true;
                let mut field = |name: &str, value: Option<&RawValue>| {
                    if let Some(value) = value {
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        out.push('"');
                        out.push_str(name);
                        out.push_str("\":");
                        out.push_str(value.get());
                    }
                };
                field("seq", e.seq);
                field("type", e.kind);
                field("id", e.id);
                let kind = e
                    .kind
                    .and_then(|v| serde_json::from_str::<String>(v.get()).ok());
                match kind.as_deref() {
                    Some("turn.start") => {
                        field("at", e.at);
                        field("text", e.text);
                        field("local", e.local);
                        field("wake", e.wake);
                    }
                    Some("item.start") => {
                        field("at", e.at);
                        field("kind", e.item_kind);
                    }
                    Some("item.delta") => {}
                    Some("item.done") => {
                        field("at", e.at);
                    }
                    _ => {}
                }
                out.push('}');
                // Keep delta text in the borrowed buffer until JS knows that
                // this reply is open and still needs words. Tool text never
                // crosses the native boundary in normal saved logs.
                if kind.as_deref() == Some("item.delta") {
                    if let Some(text) = e.text {
                        let offset = text.get().as_ptr() as usize - bytes.as_ptr() as usize;
                        out.push_str(&format!(",{offset},{}", offset + text.get().len()));
                    }
                }
                out.push(']');
            } else {
                out.push_str(&format!("[null,{start},{end}]"));
            }
        }
        match newline {
            Some(end) => start = end + 1,
            None => break,
        }
    }
    out.push(']');
    out
}

/// Return search fields and lazy delta-text ranges, borrowing one input buffer.
#[napi]
pub fn extract_search_events(bytes: Buffer) -> String {
    extract(bytes.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_delta_text_in_the_borrowed_buffer() {
        let bytes =
            "{\"seq\":1,\"type\":\"item.delta\",\"id\":null,\"text\":\"اردو 😀\"}\n".as_bytes();
        let rows: serde_json::Value = serde_json::from_str(&extract(bytes)).unwrap();
        assert_eq!(rows[0][0]["id"], serde_json::Value::Null);
        assert!(rows[0][0].get("text").is_none());
        let from = rows[0][1].as_u64().unwrap() as usize;
        let to = rows[0][2].as_u64().unwrap() as usize;
        assert_eq!(
            std::str::from_utf8(&bytes[from..to]).unwrap(),
            "\"اردو 😀\""
        );
    }

    #[test]
    fn returns_unusual_rows_to_javascript() {
        for bytes in [
            b"{\"seq\":1,\"seq\":2}".as_slice(),
            b"{bad",
            b"[1,2]",
            b"{\"seq\":1,\"text\":\"\xff\"}",
            b"{\"type\":\"item.delta\",\"text\":\"torn",
        ] {
            let rows: serde_json::Value = serde_json::from_str(&extract(bytes)).unwrap();
            assert_eq!(rows, serde_json::json!([[null, 0, bytes.len()]]));
        }
    }
}
