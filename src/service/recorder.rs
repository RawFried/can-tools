//! 报文录制: 将接收帧追加写入 CSV。
//!
//! 文件按本地时间命名 (`can-YYYYmmdd-HHMMSS.csv`), 位于数据目录的
//! `recordings` 子目录。列定义见 [`Recorder::create`] 写入的表头。

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use chrono::{Local, TimeZone};

use crate::can::types::FrameDto;

/// 表头 (CSV 首行)。
const HEADER: &str = "time,unix_ms,channel,id,id_hex,extended,remote,dlc,data\n";
/// 周期性 flush 间隔, 降低掉电丢数据范围。
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

/// 录制文件句柄。
pub struct Recorder {
    writer: BufWriter<File>,
    name: String,
    frames: u64,
    started_at_ms: u64,
    last_flush: Instant,
}

/// 停止录制后的摘要。
#[derive(Debug, Clone)]
pub struct RecordingSummary {
    /// 文件名。
    pub name: String,
    /// 帧数。
    pub frames: u64,
}

impl Recorder {
    /// 在 `directory` 中创建新的录制文件。
    pub fn create(directory: &Path, started_at_ms: u64) -> std::io::Result<Self> {
        create_dir_all(directory)?;
        let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut name = format!("can-{stamp}.csv");
        let mut path = directory.join(&name);
        let mut suffix = 1;
        while path.exists() {
            name = format!("can-{stamp}-{suffix}.csv");
            path = directory.join(&name);
            suffix += 1;
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(HEADER.as_bytes())?;
        Ok(Self {
            writer,
            name,
            frames: 0,
            started_at_ms,
            last_flush: Instant::now(),
        })
    }

    /// 文件名。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// 已写入帧数。
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// 开始录制的 UNIX 毫秒时间。
    pub fn started_at_ms(&self) -> u64 {
        self.started_at_ms
    }

    /// 追加一帧。
    pub fn write(&mut self, frame: &FrameDto) -> std::io::Result<()> {
        let time = Local
            .timestamp_millis_opt(frame.time_ms as i64)
            .single()
            .map(|value| value.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
            .unwrap_or_else(|| frame.time_ms.to_string());
        let id_hex = if frame.extended {
            format!("0x{:08X}", frame.id)
        } else {
            format!("0x{:03X}", frame.id)
        };
        writeln!(
            self.writer,
            "{time},{},{},{},{},{},{},{},{}",
            frame.time_ms,
            frame.channel + 1,
            frame.id,
            id_hex,
            u8::from(frame.extended),
            u8::from(frame.remote),
            frame.dlc,
            frame.data
        )?;
        self.frames += 1;
        if self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.writer.flush()?;
            self.last_flush = Instant::now();
        }
        Ok(())
    }

    /// flush 并关闭文件。
    pub fn finish(mut self) -> std::io::Result<RecordingSummary> {
        self.writer.flush()?;
        Ok(RecordingSummary {
            name: self.name.clone(),
            frames: self.frames,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u64, extended: bool, data: &str) -> FrameDto {
        FrameDto {
            seq,
            time_ms: 1_700_000_000_123 + seq as i64 as u64,
            device_ts: 0,
            channel: 0,
            id: if extended { 0x01AB_CDEF } else { 0x123 },
            extended,
            remote: false,
            dlc: 3,
            data: data.to_string(),
        }
    }

    #[test]
    fn writes_header_and_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::create(dir.path(), 1_700_000_000_000).unwrap();
        recorder.write(&frame(1, false, "01 02 03")).unwrap();
        recorder.write(&frame(2, true, "AA BB CC")).unwrap();
        let summary = recorder.finish().unwrap();
        assert_eq!(summary.frames, 2);
        let content = std::fs::read_to_string(dir.path().join(&summary.name)).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], HEADER.trim_end());
        assert!(lines[1].contains(",1,291,0x123,0,0,3,01 02 03"));
        assert!(lines[2].contains(&format!(",1,{},0x01ABCDEF,1,0,3,AA BB CC", 0x01AB_CDEF)));
    }

    #[test]
    fn avoids_overwriting_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = Recorder::create(dir.path(), 0).unwrap();
        let first_name = first.name().to_string();
        let second = Recorder::create(dir.path(), 0).unwrap();
        assert_ne!(first_name, second.name());
        assert!(second.name().ends_with(".csv"));
    }
}
