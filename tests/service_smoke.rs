//! 无硬件场景下的工作线程冒烟测试: 命令通道、错误路径与关闭流程。

use can_tools::can::types::{BaudRate, CanMode, HardwareFilter, SendFrameRequest, StartConfig};
use can_tools::service::CanService;
use can_tools::state::{ServerInfo, SharedState};

#[tokio::test]
async fn worker_rejects_operations_without_device_and_shuts_down() {
    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-test".to_string(),
    });
    let dir = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), dir.path().join("recordings")).unwrap();

    let config = StartConfig {
        channels: vec![0],
        baud: BaudRate::Kbps500,
        mode: CanMode::Normal,
        filter: HardwareFilter::default(),
        software_filters: vec![],
    };
    assert!(service.configure(config).await.is_err());
    assert!(service.start_recording().await.is_err());
    assert!(service.stop_recording().await.is_err());
    let send = SendFrameRequest {
        channel: 0,
        id: 0x123,
        extended: false,
        remote: false,
        dlc: None,
        data: "11 22".to_string(),
    };
    assert!(service.send(send).await.is_err());
    assert!(service.close().await.is_ok());
    assert!(service.stop(None).await.is_ok());
    assert!(service.list_devices().await.is_ok());

    service.shutdown().await;
    assert!(!shared.status().device.open);
}
