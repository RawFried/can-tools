//! `can-tools` 二进制入口: 解析参数、启动 CAN 工作线程与 Web 服务。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use can_tools::paths;
use can_tools::server::{self, AppState};
use can_tools::service::CanService;
use can_tools::state::{ServerInfo, SharedState};

/// Web 上位机: 配置 USBCAN 波特率/滤波并录制报文。
#[derive(Debug, Parser)]
#[command(name = "can-tools", version, about)]
struct Cli {
    /// 监听地址 (默认仅本机可访问)。
    #[arg(short = 'H', long, default_value = "127.0.0.1")]
    host: String,
    /// 监听端口。
    #[arg(short, long, default_value_t = 8787)]
    port: u16,
    /// 数据目录 (录制文件写入其中的 recordings 子目录)。
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// 启动后不自动打开浏览器。
    #[arg(long)]
    no_browser: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("can_tools=info")),
        )
        .init();

    let data_dir = cli.data_dir.unwrap_or_else(paths::default_data_dir);
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("无法创建数据目录 {}", data_dir.display()))?;
    let recordings_dir = data_dir.join("recordings");

    let server_info = ServerInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: data_dir.display().to_string(),
    };
    let shared = SharedState::new(server_info);
    let service = Arc::new(
        CanService::spawn(shared.clone(), recordings_dir).context("无法启动 CAN 工作线程")?,
    );
    let state = AppState {
        shared: shared.clone(),
        service: service.clone(),
        data_dir: data_dir.clone(),
    };

    let listener = TcpListener::bind((cli.host.as_str(), cli.port))
        .await
        .with_context(|| format!("无法监听 {}:{}", cli.host, cli.port))?;
    let address = listener.local_addr()?;
    let display_host = match cli.host.as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        host => host,
    };
    let url = format!("http://{display_host}:{}/", address.port());
    println!("CAN Tools {} 已启动: {url}", env!("CARGO_PKG_VERSION"));
    println!("数据目录: {}", data_dir.display());
    if !cli.no_browser {
        open_browser(&url);
    }

    let app = server::router(state);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("Web 服务异常退出")?;
    service.shutdown().await;
    tracing::info!("已退出");
    Ok(())
}

/// 在图形会话中打开默认浏览器; 无桌面环境时静默跳过。
fn open_browser(url: &str) {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return;
        }
        let result = Command::new("xdg-open")
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Err(error) = result {
            tracing::warn!("无法打开浏览器: {error}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = url;
    }
}

/// 等待 Ctrl-C 或 SIGTERM。
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!("无法安装 Ctrl-C 处理器: {error}");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!("无法安装 SIGTERM 处理器: {error}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
      () = ctrl_c => {}
      () = terminate => {}
    }
    tracing::info!("收到退出信号");
}
