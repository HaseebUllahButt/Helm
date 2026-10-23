//! Batch Linux discovery reads. JavaScript retains policy and recovery.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{fs, path::Path};

#[napi(object)]
pub struct DiscoveredProcess {
    pub pid: f64,
    pub argv: Vec<String>,
}

// Returning None asks JavaScript to handle unusual names itself. In particular,
// it converts a directory name to Number before opening that process's cmdline.
#[napi]
pub fn discovery_process_list(root: String) -> Option<Vec<DiscoveredProcess>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(&root).ok()? {
        let name = entry.ok()?.file_name().into_string().ok()?;
        if !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) {
            let pid = name.parse::<u32>().ok()?;
            if pid.to_string() != name {
                return None;
            }
            names.push((name, pid));
        }
    }
    names.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    for (name, pid) in names {
        let Ok(bytes) = fs::read(Path::new(&root).join(name).join("cmdline")) else {
            continue;
        };
        let argv: Vec<String> = String::from_utf8_lossy(&bytes)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if !argv.is_empty() {
            out.push(DiscoveredProcess {
                pid: pid as f64,
                argv,
            });
        }
    }
    Some(out)
}

#[napi(object)]
pub struct DiscoveredDirectory {
    pub name: String,
    pub repo: bool,
}

#[napi(object)]
pub struct DirectorySnapshot {
    pub entries: Vec<DiscoveredDirectory>,
    pub count: f64,
}

pub struct ReadDirectory {
    root: String,
}
impl Task for ReadDirectory {
    type Output = Option<DirectorySnapshot>;
    type JsValue = Option<DirectorySnapshot>;
    fn compute(&mut self) -> Result<Self::Output> {
        let Some(contents) = fs::read_dir(&self.root).ok() else {
            return Ok(None);
        };
        let mut entries = Vec::new();
        let mut count = 0.0;
        for entry in contents {
            let Ok(entry) = entry else { return Ok(None) };
            count += 1.0;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Ok(None);
            };
            let Ok(kind) = entry.file_type() else {
                return Ok(None);
            };
            if !kind.is_dir() {
                continue;
            }
            // Hidden folders are never listed or indexed except .config.
            if name.starts_with('.') && name != ".config" {
                continue;
            }
            entries.push(DiscoveredDirectory {
                repo: fs::metadata(entry.path().join(".git")).is_ok(),
                name,
            });
        }
        // libuv's scandir (used by Node readdir) sorts names by UTF-8 bytes.
        entries.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        Ok(Some(DirectorySnapshot { entries, count }))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Run filesystem work in Node's worker pool, never on its main loop.
#[napi]
pub fn discovery_read_directory(root: String) -> AsyncTask<ReadDirectory> {
    AsyncTask::new(ReadDirectory { root })
}
