//! 无硬件场景下的工作线程冒烟测试: 命令通道、错误路径与关闭流程。

use can_tools::can::types::{
    BaudRate, CanMode, FilterUpdateRequest, HardwareFilter, SendFrameRequest, SocketCanConfig,
    StartConfig, UsbChannelConfig,
};
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
        usb: vec![UsbChannelConfig {
            index: 0,
            baud: BaudRate::Kbps500,
        }],
        socketcan: vec![],
        mode: CanMode::Normal,
        filter: HardwareFilter::default(),
        software_filters: vec![],
    };
    assert!(service.configure(config).await.is_err());
    let recording_error = service.start_recording().await.unwrap_err();
    assert!(
        recording_error.contains("没有运行中的链路"),
        "{recording_error}"
    );
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
    let filters = FilterUpdateRequest {
        channels: vec![0],
        filter: HardwareFilter::default(),
        software_filters: vec![],
    };
    assert!(service.update_filters(filters).await.is_err());
    assert!(service.close().await.is_ok());
    assert!(service.stop(None).await.is_ok());
    assert!(service.list_devices().await.is_ok());

    service.shutdown().await;
    assert!(!shared.status().device.open);
}

#[tokio::test]
async fn worker_reports_missing_socketcan_interface() {
    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-test".to_string(),
    });
    let dir = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), dir.path().join("recordings")).unwrap();

    let config = StartConfig {
        usb: vec![],
        socketcan: vec![SocketCanConfig {
            name: "missingcan0".to_string(),
            bitrate: None,
        }],
        mode: CanMode::Normal,
        filter: HardwareFilter::default(),
        software_filters: vec![],
    };
    let error = service.configure(config).await.unwrap_err();
    assert!(error.contains("不存在"), "{error}");
    assert!(shared
        .status()
        .channels
        .iter()
        .all(|channel| !channel.running));

    service.shutdown().await;
}
