//! Raw bus flooder: sends one frame as fast as the USBCAN accepts it, no RX drain.
//!
//! Build: cargo build --release --example bus_flood
//! Usage: bus_flood <baud_kbps> <ch:0|1> <cob_hex> <dlc:0..8> <seconds>
//!
//! Intended for RX-path stress tests on a peer node (maximises frames/second on the bus).

use std::time::{Duration, Instant};

use can_tools::can::types::{BaudRate, CanFrame, CanMode, HardwareFilter};
use canalyst_ii::device::{self, UsbCan};

fn parse_baud(s: &str) -> BaudRate {
    match s {
        "125" => BaudRate::Kbps125,
        "250" => BaudRate::Kbps250,
        "500" => BaudRate::Kbps500,
        "1000" | "1m" => BaudRate::Kbps1000,
        other => panic!("unsupported baud {other}"),
    }
}

fn open(channel: u8, baud: BaudRate) -> UsbCan {
    let deadline = Instant::now() + Duration::from_secs(10);
    let filter = HardwareFilter::default();
    loop {
        if let Ok(mut dev) = device::open(0) {
            if dev
                .init_can(channel, baud, CanMode::Normal, &filter)
                .is_ok()
                && dev.start_can(channel).is_ok()
            {
                dev.clear_buffer(channel).ok();
                return dev;
            }
        }
        if Instant::now() >= deadline {
            panic!("open canalyst-ii device failed after retries");
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let baud = parse_baud(&args[1]);
    let channel: u8 = args[2].parse().unwrap();
    let cob = u32::from_str_radix(args[3].trim_start_matches("0x"), 16).unwrap();
    let dlc: usize = args[4].parse().unwrap();
    let seconds: f64 = args[5].parse().unwrap();

    let mut frame = CanFrame {
        id: cob,
        timestamp: 0,
        remote: false,
        extended: false,
        dlc: dlc as u8,
        data: [0u8; 8],
    };
    for (i, b) in frame.data.iter_mut().take(dlc).enumerate() {
        *b = i as u8;
    }

    let dev = open(channel, baud);
    let start = Instant::now();
    let deadline = start + Duration::from_secs_f64(seconds);
    let mut sent = 0u64;
    let mut errs = 0u64;
    let mut last_report = 0.0f64;
    while Instant::now() < deadline {
        match dev.send_frame(channel, &frame) {
            Ok(()) => sent += 1,
            Err(_) => {
                errs += 1;
                std::thread::sleep(Duration::from_micros(200));
            }
        }
        let el = start.elapsed().as_secs_f64();
        if el - last_report >= 30.0 {
            last_report = el;
            println!(
                "t={el:.0}s sent={sent} fps={:.0} errs={errs}",
                sent as f64 / el
            );
        }
    }
    let el = start.elapsed().as_secs_f64();
    println!(
        "DONE sent={sent} errs={errs} elapsed={el:.2}s fps={:.0}",
        sent as f64 / el
    );
}
