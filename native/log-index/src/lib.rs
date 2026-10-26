pub mod discovery;
pub mod glance;
pub mod search;
pub mod transcript;
pub mod usage;

use napi::bindgen_prelude::{Buffer, Float64Array};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct Header<'a> {
    #[serde(borrow)]
    seq: Option<&'a RawValue>,
    #[serde(borrow, rename = "type")]
    kind: Option<&'a RawValue>,
}

// Rows contain start byte, end byte, sequence number, and context kind.
// A negative kind asks JavaScript to read an unusual or malformed row itself.
// This keeps JSON.parse's behavior for duplicate keys and legacy JSON values.
fn scan(bytes: &[u8]) -> Vec<f64> {
    let mut rows = Vec::new();
    let mut start = 0;
    loop {
        let newline = memchr::memchr(b'\n', &bytes[start..]).map(|n| start + n);
        let end = newline.unwrap_or(bytes.len());
        if end > start {
            match header(&bytes[start..end]) {
                Ok(Some((seq, kind))) => rows.extend([start as f64, end as f64, seq, kind]),
                Ok(None) => {}
                Err(()) => rows.extend([start as f64, end as f64, 0.0, -1.0]),
            }
        }
        match newline {
            Some(end) => start = end + 1,
            None => break,
        }
    }
    rows
}

fn header(bytes: &[u8]) -> Result<Option<(f64, f64)>, ()> {
    // Serde can decode a struct from a JSON array. JSON.parse does not give
    // an array a sequence property, so only JSON objects use this fast path.
    if bytes.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{') {
        return Err(());
    }
    let event: Header = serde_json::from_slice(bytes).map_err(|_| ())?;
    let Some(seq) = event.seq else {
        return Ok(None);
    };
    let Ok(seq) = seq.get().parse::<f64>() else {
        return Ok(None);
    };
    let kind = match event.kind {
        None => 0.0,
        Some(raw) if raw.get() == "null" => 0.0,
        Some(raw) => {
            let kind: String = serde_json::from_str(raw.get()).map_err(|_| ())?;
            if kind == "turn.start" {
                2.0
            } else if kind.starts_with("turn.")
                || kind.starts_with("permission.")
                || kind == "item.start"
                || kind == "item.done"
            {
                1.0
            } else {
                0.0
            }
        }
    };
    Ok(Some((seq, kind)))
}

/// Scan bytes already read by Helm. Do not open files or retain chat payloads.
#[napi]
pub fn scan_event_positions(bytes: Buffer) -> Float64Array {
    Float64Array::new(scan(bytes.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_rows_keep_their_context() {
        for kind in ["permission.request", "permission.resolved"] {
            let body = format!(r#"{{"seq":1,"type":"{kind}"}}"#);
            assert_eq!(header(body.as_bytes()), Ok(Some((1.0, 1.0))));
        }
    }

    #[test]
    fn unicode_offsets_and_unterminated_rows() {
        let first = "{\"seq\":1,\"type\":\"turn.start\",\"text\":\"اردو 😀\"}\n";
        let body = format!("{first}{{\"seq\":2,\"type\":\"item.delta\"}}");
        let rows = scan(body.as_bytes());
        assert_eq!(rows.len(), 8);
        assert_eq!(&rows[..4], &[0.0, (first.len() - 1) as f64, 1.0, 2.0]);
        assert_eq!(
            &rows[4..],
            &[first.len() as f64, body.len() as f64, 2.0, 0.0]
        );
    }

    #[test]
    fn unusual_rows_use_the_existing_json_reader() {
        for body in [
            r#"{"seq":1,"seq":2}"#,
            r#"{"seq":2,"type":3}"#,
            "{bad",
            "null",
            r#"[1,"turn.start"]"#,
        ] {
            assert_eq!(
                scan(body.as_bytes()),
                vec![0.0, body.len() as f64, 0.0, -1.0]
            );
        }
    }

    #[test]
    fn non_numeric_sequences_are_not_events() {
        for body in [
            r#"{"seq":"1"}"#,
            r#"{"seq":null}"#,
            r#"{"type":"turn.start"}"#,
        ] {
            assert!(scan(body.as_bytes()).is_empty());
        }
    }
}
