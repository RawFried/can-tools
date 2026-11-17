//! 硬件验收滤波布局验证: 需要真实 USBCAN 设备 (04d8:0053)。
//!
//! 运行: `cargo test --test hw_filter -- --ignored --nocapture`
//!
//! 固件使用归一化的 32 位验收滤波值 (自测回环实测):
//! - 标准帧: `acc_code = id << 21`, `acc_mask = 0x001F_FFFF`;
//! - 扩展帧: `acc_code = id << 3`, `acc_mask = 0x0000_0007`;
//! - 滤波方式 1 (单滤波)。
//!
//! 该布局是 Web UI “按 ID 生成” helper 的依据。

use std::time::Duration;

use can_tools::can::types::{BaudRate, CanFrame, CanMode, HardwareFilter};
use canalyst_ii::device;
use canalyst_ii::UsbCan;

fn make_frame(id: u32, extended: bool, marker: u8) -> CanFrame {
    let mut data = [0u8; 8];
    data[0] = marker;
    CanFrame {
        id,
        extended,
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

fn collect(can: &mut UsbCan) -> Vec<(u32, bool)> {
    let mut out = Vec::new();
    for _ in 0..30 {
        for frame in can.drain(0, 8).expect("drain") {
            out.push((frame.id, frame.extended));
        }
        if !out.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    out
}

fn run_case(can: &mut UsbCan, filter: HardwareFilter, frames: &[CanFrame]) -> Vec<(u32, bool)> {
    can.init_can(0, BaudRate::Kbps500, CanMode::SelfTest, &filter)
        .expect("init");
    can.start_can(0).expect("start");
    can.clear_buffer(0).expect("clear");
    std::thread::sleep(Duration::from_millis(60));
    drain_all(can);
    for frame in frames {
        can.send_frame(0, frame).expect("send");
    }
    std::thread::sleep(Duration::from_millis(80));
    let received = collect(can);
    can.reset_can(0).expect("reset");
    received
}

#[test]
#[ignore = "requires USBCAN hardware (04d8:0053) with self-test loopback"]
fn acceptance_filter_uses_normalized_layout() {
    let mut can = device::open(0).expect("open");

    for mode in [1u8, 2u8] {
        let standard_filter = HardwareFilter {
            acc_code: 0x123 << 21,
            acc_mask: 0x001F_FFFF,
            mode,
        };
        let received = run_case(
            &mut can,
            standard_filter,
            &[
                make_frame(0x122, false, 0x22),
                make_frame(0x123, false, 0x23),
                make_frame(0x124, false, 0x24),
                make_frame(0x7FF, false, 0xFF),
            ],
        );
        println!("标准帧滤波 mode={mode} 收到: {received:?}");
        assert_eq!(received, vec![(0x123, false)]);
    }

    let extended_filter = HardwareFilter {
        acc_code: 0x18FF_50E5 << 3,
        acc_mask: 0x0000_0007,
        mode: 1,
    };
    let received = run_case(
        &mut can,
        extended_filter,
        &[
            make_frame(0x18FF_50E5, true, 0xE5),
            make_frame(0x18FF_50E6, true, 0xE6),
        ],
    );
    println!("扩展帧滤波收到: {received:?}");
    assert_eq!(received, vec![(0x18FF_50E5, true)]);

    can.close().expect("close");
}
