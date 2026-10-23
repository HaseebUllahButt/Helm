use napi::bindgen_prelude::{Buffer, Float64Array};
use napi_derive::napi;

#[napi(object)]
pub struct GlancePositions {
    pub starts: Float64Array,
    pub hits: Float64Array,
}

// Match the existing byte search exactly. JSON validation stays with its caller.
#[napi]
pub fn scan_glance_positions(bytes: Buffer) -> GlancePositions {
    let (starts, hits) = positions(bytes.as_ref());
    GlancePositions {
        starts: Float64Array::new(starts.into_iter().map(|n| n as f64).collect()),
        hits: Float64Array::new(hits.into_iter().map(|n| n as f64).collect()),
    }
}

fn positions(bytes: &[u8]) -> (Vec<usize>, Vec<usize>) {
    let mut starts = Vec::new();
    let mut start = 0;
    for end in memchr::memchr_iter(b'\n', bytes).chain(std::iter::once(bytes.len())) {
        if end > start {
            starts.push(start);
        }
        start = end + 1;
    }
    let mut hits = Vec::new();
    if !starts.is_empty() {
        for needle in [
            b"\"type\":\"turn.".as_slice(),
            b"\"type\":\"permission.".as_slice(),
        ] {
            for at in memchr::memmem::find_iter(bytes, needle) {
                hits.push(starts.partition_point(|start| *start <= at) - 1);
            }
        }
    }
    hits.sort_unstable();
    hits.dedup();
    (starts, hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_rows_and_last_unterminated_record_keep_their_positions() {
        let bytes = b"\n{\"type\":\"turn.start\"}\n\n{\"type\":\"permission.request\"}";
        let (starts, hits) = positions(bytes);
        assert_eq!(starts, vec![1, 24]);
        assert_eq!(hits, vec![0, 1]);
    }
}
