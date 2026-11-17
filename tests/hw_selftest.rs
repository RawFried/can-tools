//! 自测模式硬件回环: 需要真实 USBCAN 设备 (04d8:0053)。
//!
//! 运行: `cargo test --test hw_selftest -- --ignored --nocapture`
//!
//! 使用固件的自发自收模式验证 TX 编码与 RX 解码全链路, 并覆盖三种
//! 硬件滤波方式 (0/1/2) 在 AccMask=0xFFFFFFFF 下都应接收全部帧。

use std::time::Duration;

use can_tools::can::types::{BaudRate, CanFrame, CanMode, HardwareFilter};
use canalyst_ii::device;

#[test]
#[ignore = "requires USBCAN hardware (04d8:0053) with self-test loopback"]
fn self_test_tx_is_received_for_all_filter_modes() {
    let mut can = device::open(0).expect("打开设备失败");
    for filter_mode in 0..=2u8 {
        let filter = HardwareFilter {
            mode: filter_mode,
            ..HardwareFilter::default()
        };
        can.init_can(0, BaudRate::Kbps500, CanMode::SelfTest, &filter)
            .expect("初始化失败");
        can.start_can(0).expect("启动失败");
        std::thread::sleep(Duration::from_millis(50));

        let frame = CanFrame {
            id: 0x123,
            dlc: 8,
            data: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            ..Default::default()
        };
        can.send_frame(0, &frame).expect("发送失败");

        let mut received = Vec::new();
        for _ in 0..20 {
            received.extend(can.drain(0, 8).expect("接收失败"));
            if !received.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        println!(
            "filter_mode={filter_mode} 自测回环收到 {} 帧: {received:?}",
            received.len()
        );
        can.reset_can(0).expect("复位失败");
        assert!(
            received
                .iter()
                .any(|item| item.id == 0x123 && item.data == frame.data),
            "filter_mode={filter_mode} 未收到自测回环帧"
        );
    }
    can.close().expect("关闭失败");
}
