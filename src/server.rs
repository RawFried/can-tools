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

use crate::can::types::{FilterUpdateRequest, SendFrameRequest, StartConfig};
use crate::service::CanService;
use crate::state::SharedState;

/// 路由共享状态。
#[derive(Clone)]
pub struct AppState {
    /// 实时状态与事件广播。
    pub shared: Arc<SharedState>,
    /// CAN 工作线程句柄。
    pub service: Arc<CanService>,
    /// 数据目录根 (录制文件位于其 `recordings` 子目录)。
    pub data_dir: PathBuf,
}

/// 构造完整路由。
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.css", get(stylesheet))
        .route("/app.js", get(script))
        .route("/favicon.svg", get(icon))
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
        .route("/api/frames/clear", post(clear_frames))
        .route("/api/recordings", get(list_recordings))
        .route(
            "/api/recordings/{name}",
            get(download_recording).delete(delete_recording),
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

async fn list_devices(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let devices = state.service.list_devices().await.map_err(ApiError::bad)?;
    Ok(Json(json!({"devices": devices})))
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

async fn clear_frames(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.service.clear_frames().await.map_err(ApiError::bad)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, serde::Serialize)]
struct RecordingEntry {
    name: String,
    size: u64,
    modified_ms: u64,
}

async fn list_recordings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let directory = recordings_dir(&state.data_dir);
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
    let path = recording_path(&state.data_dir, &name)?;
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
    let path = recording_path(&state.data_dir, &name)?;
    tokio::fs::remove_file(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("录制文件不存在")
        } else {
            ApiError::internal(format!("删除录制文件失败: {error}"))
        }
    })?;
    Ok(Json(json!({"ok": true})))
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state.shared))
}

async fn handle_socket(mut socket: WebSocket, shared: Arc<SharedState>) {
    let snapshot = json!({
      "type": "snapshot",
      "status": shared.status(),
      "frames": shared.frames(),
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

fn recordings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings")
}

fn recording_path(data_dir: &Path, name: &str) -> Result<PathBuf, ApiError> {
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
    Ok(recordings_dir(data_dir).join(name))
}

/// API 错误响应。
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

    #[test]
    fn recording_path_rejects_traversal_and_non_csv() {
        let root = Path::new("/tmp/can-tools");
        assert!(recording_path(root, "../secret.csv").is_err());
        assert!(recording_path(root, "a/b.csv").is_err());
        assert!(recording_path(root, ".hidden.csv").is_err());
        assert!(recording_path(root, "notes.txt").is_err());
        assert!(recording_path(root, "can-20260101-120000.csv").is_ok());
    }
}
