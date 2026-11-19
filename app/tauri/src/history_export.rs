use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

const APPROVED_DIRECTORY_FILE: &str = "automatic-history-export-directory";

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TemporaryExport(PathBuf);

impl Drop for TemporaryExport {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn dates_filename(filename: &str) -> bool {
    let Some(dates) = filename
        .strip_prefix("pomatez-")
        .and_then(|f| f.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let Some((first, last)) = dates.split_once('_') else {
        return false;
    };
    [first, last].iter().all(|date| {
        date.len() == 10
            && date.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
    })
}

fn stage_export(downloads: &Path, contents: &str) -> io::Result<TemporaryExport> {
    let (temporary, mut file) = loop {
        let path = downloads.join(format!(
            ".pomatez-{}-{}.partial",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => break (TemporaryExport(path), file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    drop(file);
    Ok(temporary)
}

fn write_new(downloads: &Path, filename: &str, contents: &str) -> io::Result<PathBuf> {
    let temporary = stage_export(downloads, contents)?;
    let stem = filename.trim_end_matches(".jsonl");
    for index in 0..1000 {
        let destination = if index == 0 {
            downloads.join(filename)
        } else {
            downloads.join(format!("{stem}-{index}.jsonl"))
        };
        match fs::hard_link(&temporary.0, &destination) {
            Ok(()) => return Ok(destination),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "Too many existing exports",
    ))
}

fn automatic_filename(filename: &str) -> bool {
    filename
        .strip_prefix("pomatez-auto-")
        .and_then(|stem| stem.strip_suffix(".jsonl"))
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn valid_export_contents(contents: &str) -> bool {
    contents.starts_with("{\"record_type\":\"export_header\"")
        && contents.ends_with('\n')
        && contents.len() <= 32 * 1024 * 1024
}

fn existing_automatic_export(destination: &Path, contents: &str) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.is_file() && metadata.len() == contents.len() as u64 {
        let mut existing = Vec::new();
        fs::File::open(destination)?
            .take(metadata.len() + 1)
            .read_to_end(&mut existing)?;
        if existing == contents.as_bytes() {
            return Ok(true);
        }
    }
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "An export with the same filename contains different data",
    ))
}

fn write_automatic(directory: &Path, filename: &str, contents: &str) -> io::Result<&'static str> {
    let destination = directory.join(filename);
    if existing_automatic_export(&destination, contents)? {
        return Ok("unchanged");
    }
    let temporary = stage_export(directory, contents)?;
    match fs::hard_link(&temporary.0, &destination) {
        Ok(()) => Ok("saved"),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if existing_automatic_export(&destination, contents)? {
                Ok("unchanged")
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn persist_approved_directory(config: &Path, directory: &str) -> io::Result<()> {
    fs::create_dir_all(config)?;
    let mut approval = tempfile::NamedTempFile::new_in(config)?;
    approval.write_all(directory.as_bytes())?;
    approval.as_file().sync_all()?;
    approval.persist(config.join(APPROVED_DIRECTORY_FILE))?;
    Ok(())
}

#[tauri::command]
pub async fn choose_history_export_directory<R: Runtime>(
    window: tauri::Window<R>,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("Invalid directory selection request".into());
    }
    let config = window
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = window
            .dialog()
            .file()
            .set_title("Choose automatic history export folder")
            .set_parent(&window)
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = selection.into_path().map_err(|error| error.to_string())?;
        let directory = path.canonicalize().map_err(|error| error.to_string())?;
        let directory = directory
            .to_str()
            .ok_or("The selected folder path is not valid UTF-8")?;
        persist_approved_directory(&config, directory).map_err(|error| error.to_string())?;
        Ok(Some(directory.to_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_automatic_history_export<R: Runtime>(
    window: tauri::Window<R>,
    directory: String,
    filename: String,
    contents: String,
) -> Result<&'static str, String> {
    if window.label() != "main"
        || !Path::new(&directory).is_absolute()
        || !automatic_filename(&filename)
        || !valid_export_contents(&contents)
    {
        return Err("Invalid automatic history export request".into());
    }
    let config = window
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        if filename
            != format!(
                "pomatez-auto-{:x}.jsonl",
                Sha256::digest(contents.as_bytes())
            )
        {
            return Err("Automatic export filename does not match its contents".into());
        }
        let approved = fs::read_to_string(config.join(APPROVED_DIRECTORY_FILE))
            .map_err(|_| "Select the automatic export folder again")?;
        let path = Path::new(&directory);
        if approved != directory {
            return Err("Select the automatic export folder again".into());
        }
        let resolved = path.canonicalize().map_err(|error| error.to_string())?;
        if resolved != path {
            return Err("Select the automatic export folder again".into());
        }
        write_automatic(path, &filename, &contents).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_history_jsonl<R: Runtime>(
    window: tauri::Window<R>,
    filename: String,
    contents: String,
) -> Result<String, String> {
    if window.label() != "main" || !dates_filename(&filename) || !valid_export_contents(&contents) {
        return Err("Invalid history export request".into());
    }
    let downloads = window
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        write_new(&downloads, &filename, &contents)
            .map(|destination| destination.to_string_lossy().into_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_export_preserves_existing_files_and_retries_safely() {
        let folder = tempfile::tempdir().unwrap();
        let filename = format!("pomatez-auto-{}.jsonl", "a".repeat(64));
        let destination = folder.path().join(&filename);
        assert_eq!(
            write_automatic(folder.path(), &filename, "first\n").unwrap(),
            "saved"
        );
        assert_eq!(
            write_automatic(folder.path(), &filename, "first\n").unwrap(),
            "unchanged"
        );
        assert_eq!(
            write_automatic(folder.path(), &filename, "second\n")
                .unwrap_err()
                .kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_to_string(destination).unwrap(), "first\n");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
        assert_eq!(
            write_automatic(&folder.path().join("missing"), &filename, "first\n")
                .unwrap_err()
                .kind(),
            ErrorKind::NotFound
        );
    }

    #[test]
    fn folder_approval_replaces_the_old_path() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        persist_approved_directory(&config, "/first").unwrap();
        persist_approved_directory(&config, "/second").unwrap();
        assert_eq!(
            fs::read_to_string(config.join(APPROVED_DIRECTORY_FILE)).unwrap(),
            "/second"
        );
        assert_eq!(fs::read_dir(config).unwrap().count(), 1);
    }

    #[test]
    fn only_automatic_export_names_are_accepted() {
        let valid = format!("pomatez-auto-{}.jsonl", "af".repeat(32));
        assert!(automatic_filename(&valid));
        assert!(!automatic_filename(&format!("../{valid}")));
        assert!(!automatic_filename(&valid.to_uppercase()));
        assert!(!automatic_filename("pomatez-auto-abcd.jsonl"));
    }
}
