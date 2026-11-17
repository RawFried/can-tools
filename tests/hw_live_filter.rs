//! 运行时滤波热更新探测: 在不停通道的情况下重新 InitCAN + StartCAN。
//!
//! 运行: `cargo test --test hw_live_filter -- --ignored --nocapture`

use std::time::Duration;

use can_tools::can::types::{BaudRate, CanFrame, CanMode, HardwareFilter};
use canalyst_ii::device;
use canalyst_ii::UsbCan;

fn make_frame(id: u32, marker: u8) -> CanFrame {
    let mut data = [0u8; 8];
    data[0] = marker;
    CanFrame {
        id,
        dlc: 1,
        data,
        ..Default::default()
    }
}

fn drain_all(can: &mut UsbCan) {
    for _ in 0..8 {
        if can.drain(0, 8).expect("drain").is_empty() {
            break;
        }
    }
}

fn wait_for(can: &mut UsbCan, id: u32) -> bool {
    for _ in 0..20 {
        for frame in can.drain(0, 8).expect("drain") {
            if frame.id == id {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
#[ignore = "requires USBCAN hardware (04d8:0053)"]
fn live_filter_update_without_reset() {
    let mut can = device::open(0).expect("open");
    let accept_all = HardwareFilter::default();
    can.init_can(0, BaudRate::Kbps500, CanMode::SelfTest, &accept_all)
        .expect("init");
    can.start_can(0).expect("start");
    std::thread::sleep(Duration::from_millis(80));
    drain_all(&mut can);

    can.send_frame(0, &make_frame(0x124, 0x24))
        .expect("send 0x124");
    assert!(wait_for(&mut can, 0x124), "accept-all should receive 0x124");
    drain_all(&mut can);

    // 热更新: 不调用 reset_can, 直接 InitCAN + StartCAN。
    let only_123 = HardwareFilter::for_id(0x123, false).expect("filter");
    can.init_can(0, BaudRate::Kbps500, CanMode::SelfTest, &only_123)
        .expect("init live filter");
    can.start_can(0).expect("start live filter");
    std::thread::sleep(Duration::from_millis(80));
    drain_all(&mut can);

    can.send_frame(0, &make_frame(0x124, 0x24))
        .expect("send 0x124 again");
    let blocked = wait_for(&mut can, 0x124);
    drain_all(&mut can);
    can.send_frame(0, &make_frame(0x123, 0x23))
        .expect("send 0x123");
    let allowed = wait_for(&mut can, 0x123);

    println!("live filter: blocked 0x124={blocked}, allowed 0x123={allowed}");
    can.reset_can(0).expect("reset");
    can.close().expect("close");
    assert!(!blocked, "0x124 should be filtered after live update");
    assert!(allowed, "0x123 should pass after live update");
}
