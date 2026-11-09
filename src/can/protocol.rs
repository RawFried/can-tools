//! USBCAN 协议编解码。
//!
//! 逐字节对齐 C 参考驱动 `usbcan_driver_gs` (固件 CAN-Linux V3.51):
//!
//! - 命令包 64 字节, 通道 0 命令端点 `0x02`, 通道 1 命令端点 `0x04`;
//! - TX 帧 64 字节整包, `[0]` 恒为 `0x01`, 远程标志只写 `[11]`;
//! - RX 传输 128 字节 = 最多两个 64 字节子块, 每个子块是变长紧凑帧流;
//! - InitCAN 包 56 字节, `[40..56]` 必须为 `0x340` 小端 u32 ×4, 否则
//!   通道无法收发; StartCAN 复用同一配置包, 仅把命令字改为 `0x02`。
//!
//! 协议来源: `can_service/usbcan_driver_gs/src/usbcan_protocol.c` 与
//! `can_service/multi-can/crates/usbcan-async/AGENTS.md`。

use crate::can::types::{BaudRate, CanFrame, CanMode, HardwareFilter};

/// 设备厂商 ID。
pub const VID: u16 = 0x04D8;
/// 设备产品 ID。
pub const PID: u16 = 0x0053;
/// 最多扫描的设备数量。
pub const MAX_DEV: usize = 16;
/// 命令包/ TX 帧长度。
pub const COMMAND_PACKET_SIZE: usize = 64;
/// InitCAN 配置包有效长度。
pub const INIT_CONFIG_PACKET_SIZE: usize = 56;
/// 单个 RX 子块长度。
pub const RX_BLOCK_SIZE: usize = 64;
/// 单次 RX bulk 传输长度。
pub const RX_TRANSFER_SIZE: usize = 128;
/// 单块最大帧数保护。
pub const MAX_FRAMES_PER_BLOCK: usize = 8;

/// 命令字。
pub mod cmd {
    /// 初始化通道。
    pub const INIT_CAN: u8 = 0x01;
    /// 启动通道。
    pub const START_CAN: u8 = 0x02;
    /// 复位通道。
    pub const RESET_CAN: u8 = 0x03;
    /// 关闭设备 (需要发送到两个通道的命令端点)。
    pub const CLOSE: u8 = 0x07;
    /// 查询接收缓冲帧数。
    pub const GET_RECEIVE_NUM: u8 = 0x0A;
    /// 清空接收缓冲。
    pub const CLEAR_BUFFER: u8 = 0x0B;
    /// 设置参考 (滤波)。
    pub const SET_REFERENCE: u8 = 0x0E;
    /// 挑战-应答握手。
    pub const HANDSHAKE: u8 = 0x13;
}

/// 一个通道使用的三个 bulk 端点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoints {
    /// 命令 OUT 端点。
    pub cmd_out: u8,
    /// 数据 TX 端点。
    pub data_out: u8,
    /// 数据 RX 端点。
    pub data_in: u8,
}

/// 返回通道端点映射; 通道号非法时返回 `None`。
pub const fn endpoints(channel: u8) -> Option<Endpoints> {
    match channel {
        0 => Some(Endpoints {
            cmd_out: 0x02,
            data_out: 0x01,
            data_in: 0x81,
        }),
        1 => Some(Endpoints {
            cmd_out: 0x04,
            data_out: 0x03,
            data_in: 0x83,
        }),
        _ => None,
    }
}

/// 编码 InitCAN 配置包。
///
/// `[40..56]` 的 `0x340` 魔数是固件要求, 缺失时命令返回成功但 CAN 引擎
/// 不会启动 —— 必须保留。
pub fn encode_init(
    baud: BaudRate,
    mode: CanMode,
    filter: &HardwareFilter,
) -> [u8; INIT_CONFIG_PACKET_SIZE] {
    let (timing0, timing1) = baud.timing();
    let mut packet = [0u8; INIT_CONFIG_PACKET_SIZE];
    packet[0] = cmd::INIT_CAN;
    packet[4..8].copy_from_slice(&filter.acc_code.to_le_bytes());
    packet[8..12].copy_from_slice(&filter.acc_mask.to_le_bytes());
    packet[16] = filter.mode;
    packet[24] = timing0;
    packet[28] = timing1;
    packet[32] = mode.as_u8();
    packet[36] = 0x01;
    for i in 0..4 {
        let offset = 40 + i * 4;
        packet[offset..offset + 4].copy_from_slice(&0x340u32.to_le_bytes());
    }
    packet
}

/// 将 InitCAN 配置包改写为 StartCAN 包 (仅命令字变化)。
pub fn to_start_packet(
    init_packet: &[u8; INIT_CONFIG_PACKET_SIZE],
) -> [u8; INIT_CONFIG_PACKET_SIZE] {
    let mut packet = *init_packet;
    packet[0] = cmd::START_CAN;
    packet
}

/// 编码 TX 帧 (64 字节整包)。
///
/// 远程帧的 `[0]` 必须保持 `0x01`, 仅写 `[11]`; 写成 `0x04` 会让设备
/// 接收计数翻倍。
pub fn encode_tx_frame(frame: &CanFrame) -> [u8; COMMAND_PACKET_SIZE] {
    let mut packet = [0u8; COMMAND_PACKET_SIZE];
    packet[0] = 0x01;
    packet[1..5].copy_from_slice(&frame.id.to_le_bytes());
    packet[9] = 0x01;
    packet[11] = u8::from(frame.remote);
    packet[12] = u8::from(frame.extended);
    let dlc = frame.dlc.min(8);
    packet[13] = dlc;
    packet[14..14 + dlc as usize].copy_from_slice(&frame.data[..dlc as usize]);
    packet
}

/// 解码一次 RX bulk 传输 (可能包含 1-2 个 64 字节子块)。
///
/// 有效帧可能出现在任一子块中, 因此必须遍历全部子块, 不能只取后半块。
pub fn decode_rx_blocks(buffer: &[u8]) -> Vec<CanFrame> {
    let mut frames = Vec::new();
    for block in buffer.chunks(RX_BLOCK_SIZE) {
        frames.extend(decode_rx_block(block));
    }
    frames
}

/// 解码单个 64 字节子块 (变长紧凑帧流)。
///
/// 布局: `[0]` = 帧数 (上限 8), 帧从偏移 1 开始, 每帧 `13 + raw_dlc` 字节:
/// `[0..4]` ID 小端, `[4..8]` 时间戳小端, `[10]` 远程, `[11]` 扩展,
/// `[12]` DLC, `[13..]` 数据。
///
/// 信任 `stream[0]` 的帧数, 不把 ID 全零当作流结束 —— ID 0 是合法 CAN 帧
/// (例如 CANopen NMT 0x000)。前 8 字节全零视为空块。
pub fn decode_rx_block(stream: &[u8]) -> Vec<CanFrame> {
    if stream.len() < 8 || stream[..8].iter().all(|&byte| byte == 0) {
        return Vec::new();
    }
    let frame_count = (stream[0] as usize).min(MAX_FRAMES_PER_BLOCK);
    let mut frames = Vec::with_capacity(frame_count);
    let mut pos = 1;
    for _ in 0..frame_count {
        let Some(header) = stream.get(pos..pos + 13) else {
            break;
        };
        let raw_dlc = header[12];
        let dlc = raw_dlc.min(8);
        let Some(data) = stream.get(pos + 13..pos + 13 + dlc as usize) else {
            break;
        };
        let mut frame_data = [0u8; 8];
        frame_data[..dlc as usize].copy_from_slice(data);
        frames.push(CanFrame {
            id: u32::from_le_bytes([header[0], header[1], header[2], header[3]]),
            timestamp: u32::from_le_bytes([header[4], header[5], header[6], header[7]]),
            remote: header[10] != 0,
            extended: header[11] != 0,
            dlc,
            data: frame_data,
        });
        pos += 13 + raw_dlc as usize;
    }
    frames
}

/// 编码挑战-应答握手包 (0x13 + 15 个 32 位随机数, 大端)。
///
/// 固件 V3.51 不强制校验应答, 发送并读取一次即可。
pub fn encode_handshake(seed: u32) -> [u8; COMMAND_PACKET_SIZE] {
    let mut packet = [0u8; COMMAND_PACKET_SIZE];
    packet[0] = cmd::HANDSHAKE;
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(0x9E37_79B9);
    for i in 1..16 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        packet[i * 4..i * 4 + 4].copy_from_slice(&state.to_be_bytes());
    }
    packet
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_frame(id: u32, timestamp: u32, data: &[u8]) -> CanFrame {
        let mut frame = CanFrame {
            id,
            timestamp,
            ..Default::default()
        };
        frame.dlc = data.len().min(8) as u8;
        frame.data[..frame.dlc as usize].copy_from_slice(&data[..frame.dlc as usize]);
        frame
    }

    fn encode_block(frames: &[CanFrame]) -> [u8; RX_BLOCK_SIZE] {
        let mut block = [0u8; RX_BLOCK_SIZE];
        block[0] = frames.len() as u8;
        let mut pos = 1;
        for frame in frames {
            block[pos..pos + 4].copy_from_slice(&frame.id.to_le_bytes());
            block[pos + 4..pos + 8].copy_from_slice(&frame.timestamp.to_le_bytes());
            block[pos + 8] = 0x01;
            block[pos + 10] = u8::from(frame.remote);
            block[pos + 11] = u8::from(frame.extended);
            block[pos + 12] = frame.dlc;
            block[pos + 13..pos + 13 + frame.dlc as usize]
                .copy_from_slice(&frame.data[..frame.dlc as usize]);
            pos += 13 + frame.dlc as usize;
        }
        block
    }

    #[test]
    fn endpoints_map_channels() {
        assert_eq!(
            endpoints(0),
            Some(Endpoints {
                cmd_out: 0x02,
                data_out: 0x01,
                data_in: 0x81
            })
        );
        assert_eq!(
            endpoints(1),
            Some(Endpoints {
                cmd_out: 0x04,
                data_out: 0x03,
                data_in: 0x83
            })
        );
        assert_eq!(endpoints(2), None);
    }

    #[test]
    fn init_packet_contains_required_magic_and_fields() {
        let filter = HardwareFilter {
            acc_code: 0x1234,
            acc_mask: 0xFFFF_FF00,
            mode: 2,
        };
        let packet = encode_init(BaudRate::Kbps125, CanMode::ListenOnly, &filter);
        assert_eq!(packet[0], cmd::INIT_CAN);
        assert_eq!(u32::from_le_bytes(packet[4..8].try_into().unwrap()), 0x1234);
        assert_eq!(
            u32::from_le_bytes(packet[8..12].try_into().unwrap()),
            0xFFFF_FF00
        );
        assert_eq!(packet[16], 2);
        assert_eq!(packet[24], 0x03);
        assert_eq!(packet[28], 0x1C);
        assert_eq!(packet[32], 1);
        for i in 0..4 {
            let offset = 40 + i * 4;
            assert_eq!(
                u32::from_le_bytes(packet[offset..offset + 4].try_into().unwrap()),
                0x340,
                "offset {offset} must carry the firmware magic"
            );
        }
    }

    #[test]
    fn start_packet_keeps_full_configuration() {
        let packet = encode_init(
            BaudRate::Kbps500,
            CanMode::Normal,
            &HardwareFilter::default(),
        );
        let start = to_start_packet(&packet);
        assert_eq!(start[0], cmd::START_CAN);
        assert_eq!(start[28], 0x1C);
        assert_eq!(&start[4..56], &packet[4..56]);
    }

    #[test]
    fn tx_standard_frame_layout() {
        let frame = make_frame(0x123, 0, &[1, 2, 3, 4, 5, 6, 7, 8]);
        let packet = encode_tx_frame(&frame);
        assert_eq!(packet[0], 0x01);
        assert_eq!(u32::from_le_bytes(packet[1..5].try_into().unwrap()), 0x123);
        assert_eq!(packet[9], 0x01);
        assert_eq!(packet[11], 0);
        assert_eq!(packet[12], 0);
        assert_eq!(packet[13], 8);
        assert_eq!(&packet[14..22], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn tx_remote_frame_keeps_first_byte_one() {
        let frame = CanFrame {
            id: 0x123,
            remote: true,
            extended: true,
            ..Default::default()
        };
        let packet = encode_tx_frame(&frame);
        assert_eq!(packet[0], 0x01);
        assert_eq!(packet[11], 1);
        assert_eq!(packet[12], 1);
        assert_eq!(packet[13], 0);
    }

    #[test]
    fn decode_multiple_frames_in_one_block() {
        let first = make_frame(
            0x100,
            0x1234,
            &[0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47],
        );
        let second = CanFrame {
            id: 0x01AB_CDEF,
            timestamp: 0x99,
            remote: true,
            extended: true,
            ..Default::default()
        };
        let block = encode_block(&[first, second]);
        let frames = decode_rx_block(&block);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], first);
        assert_eq!(frames[1], second);
    }

    #[test]
    fn decode_accepts_id_zero() {
        let frame = make_frame(0, 7, &[0xAA]);
        let block = encode_block(&[frame]);
        let frames = decode_rx_block(&block);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id, 0);
        assert_eq!(frames[0].data_bytes(), &[0xAA]);
    }

    #[test]
    fn decode_ignores_empty_block() {
        assert!(decode_rx_block(&[0u8; RX_BLOCK_SIZE]).is_empty());
    }

    #[test]
    fn decode_scans_both_halves_of_a_transfer() {
        let frame = make_frame(0x321, 1, &[1, 2, 3]);
        let block = encode_block(&[frame]);
        let mut transfer = [0u8; RX_TRANSFER_SIZE];
        transfer[RX_BLOCK_SIZE..].copy_from_slice(&block);
        let frames = decode_rx_blocks(&transfer);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id, 0x321);
    }

    #[test]
    fn decode_does_not_panic_on_truncated_data() {
        let mut block = [0u8; RX_BLOCK_SIZE];
        block[0] = 1;
        block[1..5].copy_from_slice(&0x123u32.to_le_bytes());
        block[13] = 8; // 声明 8 字节数据但传输被截断
        let truncated = &block[..20];
        assert!(decode_rx_block(truncated).is_empty());
    }

    #[test]
    fn decode_clamps_frame_count() {
        let mut block = [0u8; RX_BLOCK_SIZE];
        block[0] = 200;
        for i in 0..4 {
            let pos = 1 + i * 13;
            block[pos..pos + 4].copy_from_slice(&(i as u32 + 1).to_le_bytes());
            block[pos + 12] = 0;
        }
        let frames = decode_rx_block(&block);
        assert_eq!(frames.len(), 4); // 数据不足以容纳 8 帧, 安全停止
    }

    #[test]
    fn handshake_layout() {
        let packet = encode_handshake(0xDEAD_BEEF);
        assert_eq!(packet[0], cmd::HANDSHAKE);
        assert_eq!(&packet[1..4], &[0, 0, 0]);
        assert!(packet[4..].iter().any(|&byte| byte != 0));
    }
}
