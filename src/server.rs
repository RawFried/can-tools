//! HTTP 与 WebSocket 服务: 静态前端、REST API 与实时帧推送。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::can::dbc;
use crate::can::types::{
    FilterUpdateRequest, LinkList, SendFrameRequest, StartConfig, MAX_CHANNEL,
};
use crate::paths;
use crate::service::CanService;
use crate::state::SharedState;

/// 路由共享状态。
#[derive(Clone)]
pub struct AppState {
    /// 实时状态与事件广播。
    pub shared: Arc<SharedState>,
    /// CAN 工作线程句柄。
    pub service: Arc<CanService>,
    /// 数据目录根 (录制目录默认是其 `recordings` 子目录, 可另行指定)。
    pub data_dir: PathBuf,
}

/// 构造完整路由。
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.css", get(stylesheet))
        .route("/app.js", get(script))
        .route("/favicon.svg", get(icon))
        .route("/fonts/Saira.ttf", get(saira_font))
        .route("/api/health", get(health))
        .route("/api/devices", get(list_devices))
        .route("/api/status", get(status))
        .route("/api/device/open", post(open_device))
        .route("/api/device/close", post(close_device))
        .route("/api/config", post(configure))
        .route("/api/stop", post(stop))
        .route("/api/send", post(send_frame))
        .route("/api/filters", post(update_filters))
        .route("/api/recording/start", post(start_recording))
        .route("/api/recording/stop", post(stop_recording))
        .route("/api/recording/dir", post(set_recording_dir))
        .route("/api/frames/clear", post(clear_frames))
        .route("/api/recordings", get(list_recordings))
        .route(
            "/api/recordings/{name}",
            get(download_recording).delete(delete_recording),
        )
        .route("/api/logs", get(list_logs))
        .route("/api/logs/{name}", get(download_log))
        .route(
            "/api/dbc/{channel}",
            get(get_dbc).post(upload_dbc).delete(delete_dbc),
        )
        .route("/ws", get(websocket))
        .with_state(state)
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn stylesheet() -> Response {
    asset(include_str!("../web/app.css"), "text/css; charset=utf-8")
}

async fn script() -> Response {
    asset(
        include_str!("../web/app.js"),
        "text/javascript; charset=utf-8",
    )
}

async fn icon() -> Response {
    asset(include_str!("../web/icon.svg"), "image/svg+xml")
}

/// 自托管的 Saira 可变字体 (SIL OFL 1.1，许可证见 `web/fonts/Saira-OFL.txt`)。
async fn saira_font() -> Response {
    static_bytes(include_bytes!("../web/fonts/Saira.ttf"), "font/ttf")
}

/// 二进制静态资源: 内容随二进制发布，可长期缓存。
fn static_bytes(body: &'static [u8], content_type: &'static str) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn asset(body: &'static str, content_type: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

async fn status(State(state): State<AppState>) -> Json<crate::state::Status> {
    Json(state.shared.status())
}

async fn list_devices(State(state): State<AppState>) -> Result<Json<LinkList>, ApiError> {
    let list = state.service.list_devices().await.map_err(ApiError::bad)?;
    Ok(Json(list))
}

#[derive(Debug, Deserialize)]
struct OpenRequest {
    #[serde(default)]
    index: usize,
}

async fn open_device(
    State(state): State<AppState>,
    Json(request): Json<OpenRequest>,
) -> Result<Json<Value>, ApiError> {
    state
        .service
        .open(request.index)
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn close_device(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.service.close().await.map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn configure(
    State(state): State<AppState>,
    Json(config): Json<StartConfig>,
) -> Result<Json<Value>, ApiError> {
    state
        .service
        .configure(config)
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

#[derive(Debug, Deserialize)]
struct StopRequest {
    channels: Option<Vec<u8>>,
}

async fn stop(
    State(state): State<AppState>,
    Json(request): Json<StopRequest>,
) -> Result<Json<Value>, ApiError> {
    state
        .service
        .stop(request.channels)
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn send_frame(
    State(state): State<AppState>,
    Json(request): Json<SendFrameRequest>,
) -> Result<Json<Value>, ApiError> {
    state.service.send(request).await.map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn update_filters(
    State(state): State<AppState>,
    Json(request): Json<FilterUpdateRequest>,
) -> Result<Json<Value>, ApiError> {
    state
        .service
        .update_filters(request)
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn start_recording(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let file = state
        .service
        .start_recording()
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(
        json!({"ok": true, "file": file, "status": state.shared.status()}),
    ))
}

async fn stop_recording(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let summary = state
        .service
        .stop_recording()
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(json!({
      "ok": true,
      "file": summary.name,
      "frames": summary.frames,
      "status": state.shared.status(),
    })))
}

/// 切换录制目录的请求体; 空字符串表示恢复默认目录。
#[derive(Debug, Deserialize)]
struct RecordingDirRequest {
    #[serde(default)]
    path: String,
}

/// 切换录制目录; 正在写入的录制文件继续写到原路径, 下一次录制使用新目录。
async fn set_recording_dir(
    State(state): State<AppState>,
    Json(request): Json<RecordingDirRequest>,
) -> Result<Json<Value>, ApiError> {
    let reset = request.path.trim().is_empty();
    let directory =
        paths::resolve_recordings_dir(&state.data_dir, &request.path).map_err(ApiError::bad)?;
    // 先持久化再切换运行时状态, 避免返回错误却已经改变行为。
    paths::save_recordings_dir(&state.data_dir, if reset { None } else { Some(&directory) })
        .map_err(|error| ApiError::internal(format!("保存录制目录设置失败: {error}")))?;
    state
        .service
        .set_recordings_dir(directory.clone())
        .await
        .map_err(ApiError::bad)?;
    state.shared.set_recordings_dir(&directory);
    Ok(Json(json!({"ok": true, "status": state.shared.status()})))
}

async fn clear_frames(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.service.clear_frames().await.map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize)]
struct DbcUploadRequest {
    /// 上传文件名, 用于展示与持久化。
    name: String,
    /// DBC 原始文本。
    content: String,
}

fn validate_dbc_channel(channel: u8) -> Result<(), ApiError> {
    if channel > MAX_CHANNEL {
        return Err(ApiError::bad(format!(
            "非法通道 {channel}; 合法值为 0/1 (USB) 或 2-{MAX_CHANNEL} (SocketCAN 链路)"
        )));
    }
    Ok(())
}

async fn upload_dbc(
    State(state): State<AppState>,
    AxumPath(channel): AxumPath<u8>,
    Json(request): Json<DbcUploadRequest>,
) -> Result<Json<Value>, ApiError> {
    validate_dbc_channel(channel)?;
    if request.content.len() > dbc::MAX_CONTENT_BYTES {
        return Err(ApiError::bad(format!(
            "DBC 内容超过 1 MiB 上限 (实际 {} 字节)",
            request.content.len()
        )));
    }
    let file_name = dbc_file_name(&request.name)?;
    // 定义名统一使用清洗后的文件名, 保证重启后从磁盘加载时的显示名一致。
    let definition = dbc::parse(&file_name, &request.content).map_err(ApiError::bad)?;
    persist_dbc(&state.data_dir, channel, &file_name, &request.content).await?;
    let definition = Arc::new(definition);
    state.shared.set_dbc(channel, Some(definition.clone()));
    Ok(Json(json!({
        "ok": true,
        "channel": channel,
        "dbc": definition.as_ref(),
    })))
}

async fn get_dbc(
    State(state): State<AppState>,
    AxumPath(channel): AxumPath<u8>,
) -> Result<Json<Value>, ApiError> {
    validate_dbc_channel(channel)?;
    let dbc = state.shared.dbc(channel);
    Ok(Json(json!({"channel": channel, "dbc": dbc.as_deref()})))
}

async fn delete_dbc(
    State(state): State<AppState>,
    AxumPath(channel): AxumPath<u8>,
) -> Result<Json<Value>, ApiError> {
    validate_dbc_channel(channel)?;
    clear_channel_dbc_files(&state.data_dir, channel).await?;
    state.shared.set_dbc(channel, None);
    Ok(Json(json!({"ok": true, "channel": channel})))
}

/// 清洗上传的 DBC 文件名。
///
/// 拒绝路径分隔符、空名与非 `.dbc` 后缀; 其余字符只保留 `[A-Za-z0-9._-]`,
/// 并限制长度, 避免把用户输入直接拼进数据目录。
fn dbc_file_name(name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad("DBC 文件名不能为空"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(ApiError::bad("DBC 文件名不能包含路径分隔符"));
    }
    let cleaned: String = trimmed
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        .collect();
    if cleaned == ".dbc" {
        return Err(ApiError::bad("DBC 文件名缺少名称部分"));
    }
    if !cleaned.ends_with(".dbc") {
        return Err(ApiError::bad("DBC 文件名必须以 .dbc 结尾"));
    }
    if cleaned.len() > 96 {
        return Err(ApiError::bad(format!(
            "DBC 文件名过长 (最多 96 字符, 实际 {} 字符)",
            cleaned.len()
        )));
    }
    Ok(cleaned)
}

async fn persist_dbc(
    data_dir: &Path,
    channel: u8,
    file_name: &str,
    content: &str,
) -> Result<(), ApiError> {
    let directory = data_dir.join("dbc");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| ApiError::internal(format!("创建 DBC 目录失败: {error}")))?;
    clear_channel_dbc_files(data_dir, channel).await?;
    // 固定通道前缀, 便于重启时只加载一次并建立归属; 原文件名保留在定义名中。
    let path = directory.join(format!("channel-{channel}-{file_name}"));
    tokio::fs::write(&path, content)
        .await
        .map_err(|error| ApiError::internal(format!("保存 DBC 文件失败: {error}")))?;
    Ok(())
}

/// 删除某通道在 `<data_dir>/dbc` 下的旧 `.dbc` 文件; 目录不存在时视为成功。
async fn clear_channel_dbc_files(data_dir: &Path, channel: u8) -> Result<(), ApiError> {
    let directory = data_dir.join("dbc");
    let mut reader = match tokio::fs::read_dir(&directory).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ApiError::internal(format!("读取 DBC 目录失败: {error}"))),
    };
    let prefix = format!("channel-{channel}-");
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| ApiError::internal(format!("读取 DBC 目录失败: {error}")))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".dbc") {
            continue;
        }
        match tokio::fs::remove_file(entry.path()).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ApiError::internal(format!(
                    "删除旧 DBC 文件 {name} 失败: {error}"
                )))
            }
        }
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
struct RecordingEntry {
    name: String,
    size: u64,
    modified_ms: u64,
}

async fn list_recordings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let directory = recordings_dir(&state.shared);
    let mut entries = Vec::new();
    let mut reader = match tokio::fs::read_dir(&directory).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(json!({"recordings": entries})));
        }
        Err(error) => return Err(ApiError::internal(format!("读取录制目录失败: {error}"))),
    };
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| ApiError::internal(format!("读取录制目录失败: {error}")))?
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("csv") {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis() as u64);
        entries.push(RecordingEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            size: metadata.len(),
            modified_ms,
        });
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified_ms));
    Ok(Json(json!({"recordings": entries})))
}

async fn download_recording(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, ApiError> {
    let path = recording_path(&recordings_dir(&state.shared), &name)?;
    let bytes = tokio::fs::read(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("录制文件不存在")
        } else {
            ApiError::internal(format!("读取录制文件失败: {error}"))
        }
    })?;
    Response::builder()
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .body(Body::from(bytes))
        .map_err(|error| ApiError::internal(format!("构造下载响应失败: {error}")))
}

async fn delete_recording(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let path = recording_path(&recordings_dir(&state.shared), &name)?;
    tokio::fs::remove_file(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("录制文件不存在")
        } else {
            ApiError::internal(format!("删除录制文件失败: {error}"))
        }
    })?;
    Ok(Json(json!({"ok": true})))
}

/// 运行日志条目 (当前文件与轮转文件)。
#[derive(Debug, serde::Serialize)]
struct LogEntry {
    name: String,
    size: u64,
    modified_ms: u64,
}

/// `GET /api/logs`: 列出 `<data_dir>/logs` 下可下载的日志文件。
async fn list_logs(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let directory = crate::logging::log_dir(&state.data_dir);
    let mut entries = Vec::new();
    let mut reader = match tokio::fs::read_dir(&directory).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(json!({
                "dir": directory.display().to_string(),
                "files": entries,
            })));
        }
        Err(error) => return Err(ApiError::internal(format!("读取日志目录失败: {error}"))),
    };
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| ApiError::internal(format!("读取日志目录失败: {error}")))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !crate::logging::is_log_file_name(&name) {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis() as u64);
        entries.push(LogEntry {
            name,
            size: metadata.len(),
            modified_ms,
        });
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified_ms));
    Ok(Json(json!({
        "dir": directory.display().to_string(),
        "files": entries,
    })))
}

/// `GET /api/logs/{name}`: 下载当前或轮转日志文件。
async fn download_log(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, ApiError> {
    if !crate::logging::is_log_file_name(&name) {
        return Err(ApiError::bad("非法日志文件名"));
    }
    let path = crate::logging::log_dir(&state.data_dir).join(&name);
    let bytes = tokio::fs::read(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("日志文件不存在")
        } else {
            ApiError::internal(format!("读取日志文件失败: {error}"))
        }
    })?;
    Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .body(Body::from(bytes))
        .map_err(|error| ApiError::internal(format!("构造下载响应失败: {error}")))
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state.shared))
}

async fn handle_socket(mut socket: WebSocket, shared: Arc<SharedState>) {
    let dbcs: Vec<Value> = shared
        .dbcs()
        .into_iter()
        .map(|(channel, definition)| json!({"channel": channel, "dbc": definition.as_ref()}))
        .collect();
    let snapshot = json!({
      "type": "snapshot",
      "status": shared.status(),
      "frames": shared.frames(),
      "dbcs": dbcs,
    });
    if !send_json(&mut socket, &snapshot).await {
        return;
    }
    let mut receiver = shared.subscribe();
    loop {
        tokio::select! {
          event = receiver.recv() => {
            match event {
              Ok(event) => {
                if !send_json(&mut socket, &event).await {
                  break;
                }
              }
              Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let message = json!({
                  "type": "log",
                  "level": "warn",
                  "message": format!("前端处理较慢, 已跳过 {skipped} 条事件"),
                });
                if !send_json(&mut socket, &message).await {
                  break;
                }
              }
              Err(broadcast::error::RecvError::Closed) => break,
            }
          }
          message = socket.recv() => {
            match message {
              None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
              Some(Ok(_)) => {}
            }
          }
        }
    }
}

async fn send_json(socket: &mut WebSocket, value: &impl serde::Serialize) -> bool {
    let Ok(text) = serde_json::to_string(value) else {
        return false;
    };
    socket.send(Message::Text(text.into())).await.is_ok()
}

/// 当前生效的录制目录 (来自状态快照, 由 `/api/recording/dir` 更新)。
fn recordings_dir(shared: &SharedState) -> PathBuf {
    PathBuf::from(shared.status().server.recordings_dir)
}

fn recording_path(directory: &Path, name: &str) -> Result<PathBuf, ApiError> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && name.ends_with(".csv")
        && !name.starts_with('.')
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if !valid {
        return Err(ApiError::bad("非法录制文件名"));
    }
    Ok(directory.join(name))
}

/// API 错误响应。
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            tracing::error!(status = self.status.as_u16(), "{}", self.message);
        } else if self.status.is_client_error() {
            tracing::warn!(status = self.status.as_u16(), "{}", self.message);
        }
        (
            self.status,
            Json(json!({"ok": false, "error": self.message})),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ServerInfo;

    #[test]
    fn recordings_dir_follows_status_snapshot() {
        let shared = SharedState::new(ServerInfo {
            version: "test".to_string(),
            data_dir: "/tmp/can-tools".to_string(),
            recordings_dir: "/tmp/can-tools/recordings".to_string(),
        });
        assert_eq!(
            recordings_dir(&shared),
            PathBuf::from("/tmp/can-tools/recordings")
        );
        shared.set_recordings_dir(Path::new("/tmp/custom-recordings"));
        assert_eq!(
            recordings_dir(&shared),
            PathBuf::from("/tmp/custom-recordings")
        );
        // 用旧快照发布状态不会把目录回滚。
        let mut stale = shared.status();
        stale.server.recordings_dir = "/tmp/stale-recordings".to_string();
        shared.set_status(stale);
        assert_eq!(
            recordings_dir(&shared),
            PathBuf::from("/tmp/custom-recordings")
        );
    }

    #[test]
    fn recording_path_rejects_traversal_and_non_csv() {
        let root = Path::new("/tmp/can-tools/recordings");
        assert!(recording_path(root, "../secret.csv").is_err());
        assert!(recording_path(root, "a/b.csv").is_err());
        assert!(recording_path(root, ".hidden.csv").is_err());
        assert!(recording_path(root, "notes.txt").is_err());
        assert!(recording_path(root, "can-20260101-120000.csv").is_ok());
    }

    #[test]
    fn dbc_file_name_rejects_paths_and_non_dbc() {
        assert!(dbc_file_name("../x.dbc").is_err());
        assert!(dbc_file_name("a/b.dbc").is_err());
        assert!(dbc_file_name("").is_err());
        assert!(dbc_file_name("notes.txt").is_err());
        assert!(dbc_file_name("   ").is_err());
        assert!(dbc_file_name(".dbc").is_err());
    }

    #[test]
    fn dbc_file_name_filters_unsafe_characters() {
        assert_eq!(dbc_file_name(" demo.dbc ").unwrap(), "demo.dbc");
        assert_eq!(dbc_file_name("我的 demo.dbc").unwrap(), "demo.dbc");
        assert_eq!(dbc_file_name("a b@c.dbc").unwrap(), "abc.dbc");
        let long = format!("{}.dbc", "a".repeat(100));
        assert!(dbc_file_name(&long).is_err());
    }
}
