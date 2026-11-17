//! 运行日志: 控制台与 `<data_dir>/logs/can-tools.log` 双写, 按大小轮转。
//!
//! 文件日志用于事后分析: 未捕获的 panic、API 错误、通道/录制操作都会落盘。
//! 单文件默认上限 8 MiB, 保留 3 个轮转文件 (`.1` 最新, `.3` 最旧); 控制台输出
//! 保持原样。日志级别用 `RUST_LOG` 覆盖, 默认记录本程序与 USB 驱动。
//!
//! 文件写入失败不会影响主流程: 只向 stderr 提示一次, 后续静默丢弃。
//! panic 钩子使用 `try_lock` 直接写文件, 避免 panic 发生在持锁线程时死锁。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// 日志目录名 (位于数据目录下)。
pub const LOGS_DIR: &str = "logs";
/// 当前日志文件名。
pub const LOG_FILE_NAME: &str = "can-tools.log";
/// 单个日志文件的大小上限 (字节)。
pub const LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 保留的轮转文件数量: `can-tools.log.1` 到 `can-tools.log.{N}`。
pub const LOG_ROTATED_FILES: u32 = 3;
/// 未设置 `RUST_LOG` 时的默认过滤指令。
const DEFAULT_FILTER: &str = "can_tools=info,canalyst_ii=info";

/// panic 钩子使用的日志写入器; 未启用文件日志时为空。
static PANIC_SINK: OnceLock<Arc<LogSink>> = OnceLock::new();
/// 保证 panic 钩子只安装一次。
static PANIC_HOOK: OnceLock<()> = OnceLock::new();

/// 日志目录 `<data_dir>/logs`。
pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(LOGS_DIR)
}

/// 当前日志文件 `<data_dir>/logs/can-tools.log`。
pub fn log_path(data_dir: &Path) -> PathBuf {
    log_dir(data_dir).join(LOG_FILE_NAME)
}

/// 是否为可下载的日志文件名: 当前文件或 `can-tools.log.1..=LOG_ROTATED_FILES`。
///
/// 只接受固定形状, 因此不会出现路径分隔符或 `..` 越界。
pub fn is_log_file_name(name: &str) -> bool {
    if name == LOG_FILE_NAME {
        return true;
    }
    let Some(rest) = name.strip_prefix(LOG_FILE_NAME) else {
        return false;
    };
    let Some(index) = rest
        .strip_prefix('.')
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return false;
    };
    /* 只接受规范写法 `.1`..`.N`, 拒绝 `.01` 之类的变体。 */
    matches!(index, 1..=LOG_ROTATED_FILES) && rest == format!(".{index}")
}

/// 初始化日志订阅器: 文件 + 控制台。
///
/// 返回当前日志文件路径; 目录/文件无法创建时退回仅控制台并返回 `None`,
/// 不阻止程序启动。
pub fn init(data_dir: &Path) -> Option<PathBuf> {
    let directory = log_dir(data_dir);
    let sink = match LogSink::open(&directory, LOG_FILE_NAME, LOG_MAX_BYTES, LOG_ROTATED_FILES) {
        Ok(sink) => Arc::new(sink),
        Err(error) => {
            eprintln!(
                "无法启用文件日志 {}: {error}; 本次仅输出到控制台",
                log_path(data_dir).display()
            );
            init_console();
            return None;
        }
    };
    let path = sink.path();

    let filter = default_filter();
    let console = tracing_subscriber::fmt::layer().with_writer(io::stdout);
    let file = tracing_subscriber::fmt::layer()
        .with_writer(FileMakeWriter::new(Arc::clone(&sink)))
        .with_ansi(false)
        .with_thread_names(true);
    if let Err(error) = tracing_subscriber::registry()
        .with(filter)
        .with(console)
        .with(file)
        .try_init()
    {
        eprintln!("初始化日志订阅器失败: {error}; 运行日志可能不完整");
    }

    let _ = PANIC_SINK.set(Arc::clone(&sink));
    install_panic_hook();
    Some(path)
}

/// 仅控制台日志 (文件日志不可用时的回退)。
fn init_console() {
    let filter = default_filter();
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
    install_panic_hook();
}

/// 默认过滤指令; `RUST_LOG` 无效时回退到默认值。
fn default_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER))
}

/// panic 时追加一行到文件, 然后再执行默认钩子 (stderr 输出与 backtrace 设置)。
fn install_panic_hook() {
    PANIC_HOOK.get_or_init(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(sink) = PANIC_SINK.get() {
                let line = format!(
                    "{} ERROR panic: {info}\n",
                    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")
                );
                sink.try_append(line.as_bytes());
            }
            default_hook(info);
        }));
    });
}

/// 按大小轮转的线程安全日志写入器。
struct LogSink {
    directory: PathBuf,
    name: String,
    max_bytes: u64,
    keep: u32,
    state: Mutex<LogState>,
    warned: AtomicBool,
}

struct LogState {
    file: File,
    size: u64,
}

impl LogSink {
    /// 打开 (或创建) 日志文件; 已有文件已超过上限时先轮转一次。
    fn open(directory: &Path, name: &str, max_bytes: u64, keep: u32) -> io::Result<Self> {
        if max_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "日志文件大小上限不能为 0",
            ));
        }
        fs::create_dir_all(directory)?;
        let path = directory.join(name);
        let size = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let sink = Self {
            directory: directory.to_path_buf(),
            name: name.to_string(),
            max_bytes,
            keep: keep.max(1),
            state: Mutex::new(LogState { file, size }),
            warned: AtomicBool::new(false),
        };
        {
            let mut state = sink.lock_state();
            if state.size >= sink.max_bytes {
                if let Err(error) = sink.rotate(&mut state) {
                    sink.warn_once(&error);
                }
            }
        }
        Ok(sink)
    }

    fn path(&self) -> PathBuf {
        self.directory.join(&self.name)
    }

    /// 追加一个完整事件; 跨过上限时先轮转。
    fn append(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self.lock_state();
        self.write_locked(&mut state, bytes);
    }

    /// panic 钩子专用: 拿不到锁时放弃, 避免二次 panic 时死锁。
    fn try_append(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Ok(mut state) = self.state.try_lock() {
            self.write_locked(&mut state, bytes);
        }
    }

    fn write_locked(&self, state: &mut LogState, bytes: &[u8]) {
        if state.size > 0 && state.size.saturating_add(bytes.len() as u64) > self.max_bytes {
            if let Err(error) = self.rotate(state) {
                self.warn_once(&error);
            }
        }
        match state.file.write_all(bytes) {
            Ok(()) => {
                state.size = state.size.saturating_add(bytes.len() as u64);
                /* 每条事件立刻刷盘, 进程异常退出时仍能保留最近的日志。 */
                if let Err(error) = state.file.flush() {
                    self.warn_once(&error);
                }
            }
            Err(error) => self.warn_once(&error),
        }
    }

    /// 轮转: 删除最旧文件, 依次改名, 再把当前文件改名为 `.1` 并新建。
    fn rotate(&self, state: &mut LogState) -> io::Result<()> {
        state.file.flush()?;
        let current = self.path();
        let oldest = self.directory.join(format!("{}.{}", self.name, self.keep));
        match fs::remove_file(&oldest) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        for index in (1..self.keep).rev() {
            let from = self.directory.join(format!("{}.{}", self.name, index));
            let to = self.directory.join(format!("{}.{}", self.name, index + 1));
            match fs::rename(&from, &to) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        fs::rename(&current, self.directory.join(format!("{}.1", self.name)))?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&current)?;
        *state = LogState { file, size: 0 };
        Ok(())
    }

    fn lock_state(&self) -> MutexGuard<'_, LogState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 写入失败只提示一次, 避免磁盘满等问题刷屏。
    fn warn_once(&self, error: &io::Error) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            eprintln!("写运行日志失败: {error}; 本次运行不再重复提示");
        }
    }
}

/// [`tracing_subscriber`] 的写入器工厂: 每个事件凑成一行后一次性落盘。
struct FileMakeWriter {
    sink: Arc<LogSink>,
}

impl FileMakeWriter {
    fn new(sink: Arc<LogSink>) -> Self {
        Self { sink }
    }
}

impl<'a> MakeWriter<'a> for FileMakeWriter {
    type Writer = FileEventWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        FileEventWriter {
            sink: &self.sink,
            buffer: Vec::with_capacity(256),
        }
    }
}

/// 单个事件的缓冲写入器: 析构时把整条日志追加到文件。
struct FileEventWriter<'a> {
    sink: &'a LogSink,
    buffer: Vec<u8>,
}

impl Write for FileEventWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.sink.append(&self.buffer);
        self.buffer.clear();
        Ok(())
    }
}

impl Drop for FileEventWriter<'_> {
    fn drop(&mut self) {
        self.sink.append(&self.buffer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn log_file_names_accept_current_and_rotations_only() {
        assert!(is_log_file_name("can-tools.log"));
        assert!(is_log_file_name("can-tools.log.1"));
        assert!(is_log_file_name("can-tools.log.3"));
        assert!(!is_log_file_name("can-tools.log.0"));
        assert!(!is_log_file_name("can-tools.log.01"));
        assert!(!is_log_file_name("can-tools.log.4"));
        assert!(!is_log_file_name("can-tools.log.bak"));
        assert!(!is_log_file_name("../can-tools.log"));
        assert!(!is_log_file_name("can-tools.log/1"));
        assert!(!is_log_file_name(""));
    }

    #[test]
    fn appends_lines_and_rotates_by_size() {
        let directory = tempfile::tempdir().unwrap();
        let sink = LogSink::open(directory.path(), LOG_FILE_NAME, 32, 2).unwrap();
        for index in 0..12 {
            sink.append(format!("line {index}\n").as_bytes());
        }

        let current = read(&directory.path().join(LOG_FILE_NAME));
        assert!(!current.is_empty());
        assert!(current.len() <= 32, "current file: {current:?}");
        // 最新内容在当前文件里。
        assert!(current.contains("line 11"));
        assert!(directory.path().join("can-tools.log.1").exists());
        // keep=2: 只保留 .1/.2。
        assert!(!directory.path().join("can-tools.log.3").exists());
    }

    #[test]
    fn opens_by_rotating_an_oversized_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(LOG_FILE_NAME);
        fs::write(&path, "x".repeat(64)).unwrap();

        let sink = LogSink::open(directory.path(), LOG_FILE_NAME, 32, 3).unwrap();
        sink.append(b"fresh\n");
        assert_eq!(read(&path), "fresh\n");
        assert_eq!(read(&directory.path().join("can-tools.log.1")).len(), 64);
    }

    #[test]
    fn missing_directory_is_created() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("logs").join("nested");
        let sink = LogSink::open(&nested, LOG_FILE_NAME, 1024, 1).unwrap();
        sink.append(b"hello\n");
        assert_eq!(read(&nested.join(LOG_FILE_NAME)), "hello\n");
    }
}
