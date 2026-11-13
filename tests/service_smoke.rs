//! 无硬件场景下的工作线程冒烟测试: 命令通道、错误路径与关闭流程。

use can_tools::can::types::{
    BaudRate, CanMode, ChannelFilterUpdate, FilterUpdateRequest, HardwareFilter, SendFrameRequest,
    SocketCanConfig, SoftwareFilter, StartConfig, UsbChannelConfig,
};
use can_tools::service::CanService;
use can_tools::state::{ServerInfo, SharedState};

#[tokio::test]
async fn worker_rejects_operations_without_device_and_shuts_down() {
    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-test".to_string(),
        recordings_dir: "/tmp/can-tools-test/recordings".to_string(),
    });
    let dir = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), dir.path().join("recordings")).unwrap();

    let config = StartConfig {
        usb: vec![UsbChannelConfig {
            index: 0,
            baud: BaudRate::Kbps500,
            filter: HardwareFilter::default(),
            software_filters: vec![],
        }],
        socketcan: vec![],
        mode: CanMode::Normal,
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
        channels: vec![ChannelFilterUpdate {
            channel: 0,
            filter: Some(HardwareFilter::default()),
            software_filters: vec![],
        }],
    };
    assert!(service.update_filters(filters).await.is_err());
    // 空通道列表不再表示"全局更新"。
    let empty = FilterUpdateRequest { channels: vec![] };
    let error = service.update_filters(empty).await.unwrap_err();
    assert_eq!(error, "至少选择一个通道");
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
        recordings_dir: "/tmp/can-tools-test/recordings".to_string(),
    });
    let dir = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), dir.path().join("recordings")).unwrap();

    let config = StartConfig {
        usb: vec![],
        socketcan: vec![SocketCanConfig {
            name: "missingcan0".to_string(),
            bitrate: None,
            software_filters: vec![SoftwareFilter {
                extended: false,
                start: 0,
                end: 0x7FF,
            }],
        }],
        mode: CanMode::Normal,
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

#[tokio::test]
async fn worker_accepts_recordings_dir_without_device() {
    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-test".to_string(),
        recordings_dir: "/tmp/can-tools-test/recordings".to_string(),
    });
    let dir = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), dir.path().join("recordings")).unwrap();

    // 切换录制目录不需要 USB 设备, 也不要求正在录制。
    let target = dir.path().join("custom-recordings");
    service
        .set_recordings_dir(target)
        .await
        .expect("set recordings dir without device");
    assert!(service.stop(None).await.is_ok());
    assert!(!shared.status().device.open);

    service.shutdown().await;
}
