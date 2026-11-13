//! 数据目录解析与录制目录持久化。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// 返回默认数据目录。
///
/// 优先级: `CAN_TOOLS_DATA_DIR` → `XDG_DATA_HOME/can-tools` →
/// `$HOME/.local/share/can-tools` → 系统临时目录下的 `can-tools`。
pub fn default_data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("CAN_TOOLS_DATA_DIR") {
        return PathBuf::from(path);
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path).join("can-tools");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("can-tools");
    }
    std::env::temp_dir().join("can-tools")
}

/// 默认录制目录: `<data_dir>/recordings`。
pub fn default_recordings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings")
}

/// 自定义录制目录的持久化文件名 (位于数据目录下)。
pub const RECORDINGS_DIR_FILE: &str = "recording-dir.txt";

/// 读取持久化的录制目录。
///
/// 文件缺失、内容为空/空白、不是绝对路径或目录不存在时返回 `None`,
/// 由调用方回退到 [`default_recordings_dir`]。
pub fn load_recordings_dir(data_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(data_dir.join(RECORDINGS_DIR_FILE)).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() || !path.is_dir() {
        return None;
    }
    Some(path)
}

/// 持久化录制目录: `Some(path)` 写入绝对路径; `None` 删除文件 (恢复默认)。
pub fn save_recordings_dir(data_dir: &Path, path: Option<&Path>) -> std::io::Result<()> {
    let file = data_dir.join(RECORDINGS_DIR_FILE);
    match path {
        Some(path) => fs::write(file, format!("{}\n", path.display())),
        None => match fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

/// 解析并准备一个录制目录。
///
/// - 空白字符串 → 恢复默认目录 `<data_dir>/recordings` (不创建);
/// - 相对路径 → 错误;
/// - 不存在时创建, 并校验目标是目录且可写 (写一个探针文件后删除)。
pub fn resolve_recordings_dir(data_dir: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default_recordings_dir(data_dir));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("录制目录必须是绝对路径: {trimmed}"));
    }
    if path.exists() && !path.is_dir() {
        return Err(format!("录制目录不是目录: {}", path.display()));
    }
    fs::create_dir_all(&path)
        .map_err(|error| format!("创建录制目录 {} 失败: {error}", path.display()))?;
    let probe = path.join(format!(
        ".can-tools-write-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos())
    ));
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
        }
        Err(error) => return Err(format!("录制目录不可写 {}: {error}", path.display())),
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_recordings_dir_is_below_data_dir() {
        assert_eq!(
            default_recordings_dir(Path::new("/data/can-tools")),
            PathBuf::from("/data/can-tools/recordings")
        );
    }

    #[test]
    fn save_and_load_round_trip() {
        let data_dir = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        assert_eq!(load_recordings_dir(data_dir.path()), None);

        save_recordings_dir(data_dir.path(), Some(custom.path())).unwrap();
        assert!(data_dir.path().join(RECORDINGS_DIR_FILE).is_file());
        assert_eq!(
            load_recordings_dir(data_dir.path()),
            Some(custom.path().to_path_buf())
        );
    }

    #[test]
    fn load_falls_back_for_invalid_content() {
        let data_dir = tempfile::tempdir().unwrap();
        let file = data_dir.path().join(RECORDINGS_DIR_FILE);

        fs::write(&file, "  \n").unwrap();
        assert_eq!(load_recordings_dir(data_dir.path()), None);

        fs::write(&file, "relative/recordings\n").unwrap();
        assert_eq!(load_recordings_dir(data_dir.path()), None);

        fs::write(&file, "/definitely/not/an/existing/dir\n").unwrap();
        assert_eq!(load_recordings_dir(data_dir.path()), None);
    }

    #[test]
    fn reset_removes_the_persisted_file() {
        let data_dir = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        save_recordings_dir(data_dir.path(), Some(custom.path())).unwrap();
        save_recordings_dir(data_dir.path(), None).unwrap();
        assert!(!data_dir.path().join(RECORDINGS_DIR_FILE).exists());
        // 再次删除不存在文件也视为成功。
        save_recordings_dir(data_dir.path(), None).unwrap();
    }

    #[test]
    fn resolve_treats_blank_as_default() {
        let data_dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_recordings_dir(data_dir.path(), "   ").unwrap(),
            default_recordings_dir(data_dir.path())
        );
    }

    #[test]
    fn resolve_rejects_relative_paths() {
        let data_dir = tempfile::tempdir().unwrap();
        let error = resolve_recordings_dir(data_dir.path(), "relative/dir").unwrap_err();
        assert!(error.contains("绝对路径"), "{error}");
    }

    #[test]
    fn resolve_creates_directory_when_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        let target = data_dir.path().join("custom").join("recordings");
        let resolved = resolve_recordings_dir(data_dir.path(), &target.display().to_string())
            .expect("create nested directory");
        assert_eq!(resolved, target);
        assert!(target.is_dir());
    }

    #[test]
    fn resolve_rejects_unwritable_paths() {
        let data_dir = tempfile::tempdir().unwrap();
        // /proc 下无法创建子目录。
        let error = resolve_recordings_dir(data_dir.path(), "/proc/can-tools-nope").unwrap_err();
        assert!(
            error.contains("创建录制目录") || error.contains("不可写"),
            "{error}"
        );
        // 路径是普通文件而不是目录。
        let file = data_dir.path().join("not-a-dir");
        fs::write(&file, b"x").unwrap();
        let error =
            resolve_recordings_dir(data_dir.path(), &file.display().to_string()).unwrap_err();
        assert!(error.contains("不是目录"), "{error}");
    }
}
