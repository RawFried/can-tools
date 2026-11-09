//! 数据目录解析。

use std::path::PathBuf;

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
