//! 真实 SocketCAN 链路的集成测试 (不需要 USBCAN 硬件)。
//!
//! 默认使用 `vcan0`; 可用环境变量 `CAN_TOOLS_TEST_IFACE` 指定其它接口。
//! 本机运行方式:
//!
//! ```text
//! unshare -Urn sh -c 'ip link set lo up; ip link add dev vcan0 type vcan; \
//!   CAN_TOOLS_TEST_IFACE=vcan0 cargo test --test hw_socketcan -- --ignored --nocapture'
//! ```
//!
//! 用例在 root/netns 内可自动 `bring_up` 接口; 两个用例共用一个接口, 用进程内互斥锁串行。

use std::time::{Duration, Instant};

use can_tools::can::types::{
    CanMode, ChannelSource, FilterUpdateRequest, HardwareFilter, SendFrameRequest, SocketCanConfig,
    SoftwareFilter, StartConfig,
};
use can_tools::service::CanService;
use can_tools::state::{ServerInfo, SharedState};
use socketcan::{
    CanFrame, CanInterface, CanSocket, EmbeddedFrame, ExtendedId, Frame, Socket, StandardId,
};

/// 两个用例共用同一个接口, 串行执行避免互相把接口置 down / 影响收发。
///
/// 用 tokio 的异步互斥锁, 以免阻塞 runtime 线程 (用例本身是 `#[tokio::test]`)。
static IFACE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn interface() -> String {
    std::env::var("CAN_TOOLS_TEST_IFACE").unwrap_or_else(|_| "vcan0".to_string())
}

async fn wait_until(mut predicate: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if predicate() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    predicate()
}

/// 非阻塞读取对端 socket 上当前可用的全部帧。
fn drain(socket: &CanSocket) -> Vec<CanFrame> {
    let mut frames = Vec::new();
    while let Ok(frame) = socket.read_frame() {
        frames.push(frame);
    }
    frames
}

#[tokio::test]
#[ignore = "requires a real SocketCAN interface (default vcan0), run with --ignored"]
async fn socketcan_link_receives_sends_records_and_stops() {
    let _guard = IFACE_LOCK.lock().await;
    let iface = interface();
    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-socketcan-test".to_string(),
    });
    let directory = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), directory.path().join("recordings")).unwrap();

    // 1) 不打开 USB 设备, 只配置 SocketCAN 链路。
    service
        .configure(StartConfig {
            usb: vec![],
            socketcan: vec![SocketCanConfig {
                name: iface.clone(),
                bitrate: None,
            }],
            mode: CanMode::Normal,
            filter: HardwareFilter::default(),
            software_filters: vec![],
        })
        .await
        .expect("configure socketcan only");

    let status = shared.status();
    assert!(!status.device.open);
    let channel = status
        .channels
        .iter()
        .find(|channel| channel.name == iface)
        .expect("socketcan status entry");
    // 第一个注册的链路固定拿通道 2 (0/1 属于 USB)。
    assert_eq!(channel.index, 2);
    assert!(channel.running);
    assert_eq!(channel.source, ChannelSource::SocketCan);
    assert!(channel.baud.is_none() && channel.mode.is_none() && channel.filter.is_none());
    assert!(channel.bitrate.is_none(), "vcan 没有 can_bittiming");
    // 新建 netns 里 sysfs 看不到 vcan0 (unknown); 宿主命名空间可见时为 up。
    assert!(matches!(channel.state.as_deref(), Some("unknown" | "up")));

    // `/api/devices` 也应列出这条链路及其通道 id。
    let list = service.list_devices().await.expect("list devices");
    let entry = list
        .socketcan
        .iter()
        .find(|entry| entry.name == iface)
        .expect("socketcan link in device list");
    assert_eq!(entry.channel, 2);
    assert!(entry.running);

    // 2) 录制不依赖 USB 设备: 仅链路运行即可开始。
    let file = service
        .start_recording()
        .await
        .expect("start recording with socketcan only");
    assert!(file.ends_with(".csv"), "{file}");

    // 3) 另一 socket 发送标准帧/扩展帧, 帧缓冲里 channel == 2 且数据正确。
    let peer = CanSocket::open(&iface).expect("open peer socket");
    peer.set_nonblocking(true).expect("nonblocking peer");
    let standard_id = StandardId::new(0x123).unwrap();
    peer.write_frame(&CanFrame::new(standard_id, &[0x11, 0x22, 0x33]).unwrap())
        .expect("send standard frame");
    let extended_id = ExtendedId::new(0x18FF_50E5).unwrap();
    peer.write_frame(&CanFrame::new(extended_id, &[0xAA, 0xBB]).unwrap())
        .expect("send extended frame");

    let received = wait_until(
        || {
            let frames = shared.frames();
            frames
                .iter()
                .any(|frame| frame.channel == 2 && frame.id == 0x123 && frame.data == "11 22 33")
        },
        Duration::from_secs(2),
    )
    .await;
    assert!(received, "standard frame never reached the live buffer");

    let received_extended = wait_until(
        || {
            shared
                .frames()
                .iter()
                .any(|frame| frame.channel == 2 && frame.id == 0x18FF_50E5 && frame.extended)
        },
        Duration::from_secs(2),
    )
    .await;
    assert!(
        received_extended,
        "extended frame never reached the live buffer"
    );
    // 状态快照每秒发布一次, 给统计一点时间。
    let stats_updated = wait_until(
        || shared.status().stats.rx_frames >= 2,
        Duration::from_secs(2),
    )
    .await;
    assert!(stats_updated, "rx_frames never grew");

    // 4) 通过 service.send() 发送, 对端 socket 能收到。
    service
        .send(SendFrameRequest {
            channel: 2,
            id: 0x321,
            extended: false,
            remote: false,
            dlc: None,
            data: "DE AD BE EF".to_string(),
        })
        .await
        .expect("send through socketcan link");
    let mut sent = None;
    let deadline = Instant::now() + Duration::from_secs(2);
    while sent.is_none() && Instant::now() < deadline {
        sent = drain(&peer)
            .into_iter()
            .find(|frame| frame.raw_id() == 0x321 && !frame.is_error_frame());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let sent = sent.expect("peer never received the frame sent by the service");
    assert_eq!(sent.data(), &[0xDE, 0xAD, 0xBE, 0xEF]);

    // 5) 软件滤波是全局的; SocketCAN 不接受硬件滤波更新。
    let error = service
        .update_filters(FilterUpdateRequest {
            channels: vec![2],
            filter: HardwareFilter::default(),
            software_filters: vec![],
        })
        .await
        .unwrap_err();
    assert_eq!(error, "SocketCAN 链路只支持软件滤波");
    service
        .update_filters(FilterUpdateRequest {
            channels: vec![],
            filter: HardwareFilter::default(),
            software_filters: vec![SoftwareFilter {
                extended: false,
                start: 0x100,
                end: 0x1FF,
            }],
        })
        .await
        .expect("update global software filters");

    // 6) 停止链路后不再接收新帧, 也不能再发送。
    service.stop(Some(vec![2])).await.expect("stop link");
    let stopped = shared.status();
    let channel = stopped
        .channels
        .iter()
        .find(|channel| channel.name == iface)
        .expect("link stays registered after stop");
    assert!(!channel.running);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let frames_before = shared.frames().len();
    peer.write_frame(&CanFrame::new(standard_id, &[0x99]).unwrap())
        .expect("send after stop");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        shared.frames().len(),
        frames_before,
        "frames must not be ingested after stopping the link"
    );
    let send_error = service
        .send(SendFrameRequest {
            channel: 2,
            id: 0x321,
            extended: false,
            remote: false,
            dlc: None,
            data: "01".to_string(),
        })
        .await
        .unwrap_err();
    assert!(send_error.contains("未启动"), "{send_error}");

    // 7) 停止录制仍然可用 (仅链路运行过的会话)。
    let summary = service.stop_recording().await.expect("stop recording");
    assert!(summary.frames >= 2);

    service.shutdown().await;
}

#[tokio::test]
#[ignore = "requires a real SocketCAN interface and root/CAP_NET_ADMIN (vcan in unshare)"]
async fn socketcan_link_is_brought_up_automatically() {
    let _guard = IFACE_LOCK.lock().await;
    let iface = interface();

    // 先确保接口是 down: 这正是需要程序自动启用的场景。
    let netlink = CanInterface::open(&iface).expect("open netlink interface");
    netlink.bring_down().expect("bring interface down");
    let details = netlink.details().expect("interface details");
    assert!(!details.is_up, "interface should start down");

    let shared = SharedState::new(ServerInfo {
        version: "test".to_string(),
        data_dir: "/tmp/can-tools-socketcan-test".to_string(),
    });
    let directory = tempfile::tempdir().unwrap();
    let service = CanService::spawn(shared.clone(), directory.path().join("recordings")).unwrap();

    service
        .configure(StartConfig {
            usb: vec![],
            socketcan: vec![SocketCanConfig {
                name: iface.clone(),
                bitrate: Some(500_000),
            }],
            mode: CanMode::Normal,
            filter: HardwareFilter::default(),
            software_filters: vec![],
        })
        .await
        .expect("configure should bring the interface up");

    let status = shared.status();
    let channel = status
        .channels
        .iter()
        .find(|channel| channel.name == iface)
        .expect("socketcan status entry");
    assert_eq!(channel.index, 2);
    assert!(channel.running);

    // 接口已由程序启用 (vcan 不支持 bps, 但 UP 必须成功)。
    let details = CanInterface::open(&iface)
        .expect("reopen netlink interface")
        .details()
        .expect("interface details after configure");
    assert!(details.is_up, "interface should be up after configure");

    // 启用后能收到帧。
    let peer = CanSocket::open(&iface).expect("open peer socket");
    peer.set_nonblocking(true).expect("nonblocking peer");
    let standard_id = StandardId::new(0x456).unwrap();
    peer.write_frame(&CanFrame::new(standard_id, &[0xDE, 0xAD]).unwrap())
        .expect("send frame after auto bring-up");
    let received = wait_until(
        || {
            shared
                .frames()
                .iter()
                .any(|frame| frame.channel == 2 && frame.id == 0x456 && frame.data == "DE AD")
        },
        Duration::from_secs(2),
    )
    .await;
    assert!(received, "frame never reached the live buffer");

    service.shutdown().await;
}
