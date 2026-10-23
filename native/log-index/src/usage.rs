use napi_derive::napi;
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct UsageMessage<'a> {
    #[serde(borrow)]
    message_id: Option<&'a RawValue>,
    #[serde(borrow)]
    role: Option<&'a RawValue>,
    #[serde(borrow)]
    metadata: Option<&'a RawValue>,
}

fn project(records: &[String]) -> String {
    let mut output = String::from("[");
    for (index, record) in records.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        let message = if record.bytes().find(|b| !b.is_ascii_whitespace()) == Some(b'{') {
            serde_json::from_str::<UsageMessage>(record).ok()
        } else {
            None
        };
        if let Some(message) = message {
            output.push_str("[{\"message_id\":");
            output.push_str(message.message_id.map_or("null", RawValue::get));
            output.push_str(",\"role\":");
            output.push_str(message.role.map_or("null", RawValue::get));
            output.push_str(",\"metadata\":");
            output.push_str(message.metadata.map_or("null", RawValue::get));
            output.push_str("}]");
        } else {
            // Keep duplicate fields, unusual JSON, and malformed-record
            // recovery with the existing reader.
            output.push_str("[null,");
            output.push_str(
                &serde_json::to_string(record).expect("String serialization cannot fail"),
            );
            output.push(']');
        }
    }
    output.push(']');
    output
}

/// Keep usage metadata while leaving large message bodies outside JavaScript's JSON reader.
#[napi]
pub fn extract_usage_messages(records: Vec<String>) -> String {
    project(&records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_raw_metadata_without_message_bodies() {
        let rows = vec![
            r#"{"message_id":"x","metadata":{"committed_credit_cost":2},"text":"unused"}"#.into(),
        ];
        assert_eq!(
            project(&rows),
            r#"[[{"message_id":"x","role":null,"metadata":{"committed_credit_cost":2}}]]"#
        );
    }

    #[test]
    fn sends_duplicate_fields_and_damaged_records_back_to_javascript() {
        let rows = vec![
            r#"{"message_id":"first","message_id":"last"}"#.into(),
            "{bad".into(),
        ];
        let projected: serde_json::Value = serde_json::from_str(&project(&rows)).unwrap();
        assert_eq!(projected[0][1], rows[0]);
        assert_eq!(projected[1][1], rows[1]);
    }
}
