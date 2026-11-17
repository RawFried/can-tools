//! 硬件冒烟测试: 需要真实 USBCAN 设备 (04d8:0053)。
//!
//! 运行: `cargo test --test hw_smoke -- --ignored --nocapture`
//!
//! 使用只听模式启动双通道, 避免在总线上产生 ACK; 未接总线时仍应能完成
//! 初始化、启动、抽取与关闭流程。测试结束会执行完整关闭序列。

use can_tools::can::types::{BaudRate, CanMode, HardwareFilter};
use canalyst_ii::device;

#[test]
#[ignore = "requires USBCAN hardware (04d8:0053)"]
fn open_configure_and_close() {
    let devices = device::list_devices().expect("枚举设备失败");
    assert!(!devices.is_empty(), "未找到 04d8:0053 设备");
    println!("发现设备: {devices:?}");

    let mut can = device::open(0).expect("打开设备失败");
    let filter = HardwareFilter::default();
    for channel in 0..2u8 {
        can.init_can(channel, BaudRate::Kbps500, CanMode::ListenOnly, &filter)
            .expect("初始化通道失败");
        can.start_can(channel).expect("启动通道失败");
    }
    let frames = can.drain(0, 4).expect("读取失败");
    println!("100ms 内读取到 {} 帧", frames.len());
    can.reset_can(0).expect("复位 CAN1 失败");
    can.reset_can(1).expect("复位 CAN2 失败");
    can.close().expect("关闭设备失败");
}
