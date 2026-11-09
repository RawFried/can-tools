//! CAN 工作线程: 独占 USB 设备, 串行处理配置/录制命令并持续抽取接收帧。

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::can::error::Error;
use crate::can::types::{
    BaudRate, CanFrame, CanMode, HardwareFilter, SendFrameRequest, SoftwareFilter, StartConfig,
};
use crate::can::UsbCan;
use crate::service::recorder::{Recorder, RecordingSummary};
use crate::service::{now_ms, Command, Reply};
use crate::state::{ChannelStatus, DeviceStatus, RecordingStatus, SharedState, Stats, Status};

/// 单通道运行配置。
#[derive(Debug, Clone, Copy)]
struct ChannelRuntime {
    baud: BaudRate,
    mode: CanMode,
    filter: HardwareFilter,
}

/// 工作线程内部状态。
pub(crate) struct Worker {
    shared: Arc<SharedState>,
    recordings_dir: PathBuf,
    device: Option<UsbCan>,
    channels: [Option<ChannelRuntime>; 2],
    software_filters: Vec<SoftwareFilter>,
    recorder: Option<Recorder>,
    stats: Stats,
    seq: u64,
    rate_start: Instant,
    rate_frames: u64,
    last_status: Instant,
    last_close: Option<Instant>,
}

impl Worker {
    pub(crate) fn new(shared: Arc<SharedState>, recordings_dir: PathBuf) -> Self {
        Self {
            shared,
            recordings_dir,
            device: None,
            channels: [None, None],
            software_filters: Vec::new(),
            recorder: None,
            stats: Stats::default(),
            seq: 0,
            rate_start: Instant::now(),
            rate_frames: 0,
            last_status: Instant::now(),
            last_close: None,
        }
    }

    /// 主循环: 优先处理命令, 然后抽取帧并周期性发布状态。
    pub(crate) fn run(mut self, receiver: Receiver<Command>) {
        loop {
            let active = self.device.is_some() && self.channels.iter().any(Option::is_some);
            let wait = if active {
                Duration::from_millis(2)
            } else {
                Duration::from_millis(100)
            };
            match receiver.recv_timeout(wait) {
                Ok(command) => {
                    if !self.handle(command) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.shutdown();
                    break;
                }
            }
            self.poll_frames();
            self.publish_periodic();
        }
    }

    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::ListDevices { reply } => {
                let result = match self.device.as_ref() {
                    Some(device) => Ok(vec![device.info().clone()]),
                    None => self.list_devices_with_retry(),
                };
                send(reply, result);
            }
            Command::Open { index, reply } => {
                let result = self.open_device(index);
                send(reply, result);
            }
            Command::Close { reply } => {
                let result = self.close_device();
                send(reply, result);
            }
            Command::Configure { config, reply } => {
                let result = self.configure(&config);
                send(reply, result);
            }
            Command::Stop { channels, reply } => {
                let result = self.stop_channels(channels.as_deref());
                send(reply, result);
            }
            Command::StartRecording { reply } => {
                let result = self.start_recording();
                send(reply, result);
            }
            Command::StopRecording { reply } => {
                let result = self.stop_recording();
                send(reply, result);
            }
            Command::ClearFrames { reply } => {
                self.shared.clear_frames();
                self.stats = Stats::default();
                self.stats.recorded_frames = self.recorder.as_ref().map_or(0, Recorder::frames);
                self.seq = 0;
                self.rate_frames = 0;
                self.rate_start = Instant::now();
                self.publish_status();
                send(reply, Ok(()));
            }
            Command::Send { request, reply } => {
                let result = self.send_frame(&request);
                send(reply, result);
            }
            Command::Shutdown { reply } => {
                self.shutdown();
                send(reply, Ok(()));
                return false;
            }
        }
        true
    }

    /// 枚举设备。刚关闭过设备时 USB 需要重新枚举, 做短暂重试。
    fn list_devices_with_retry(&self) -> Result<Vec<crate::can::types::DeviceInfo>, String> {
        let recently_closed = self
            .last_close
            .is_some_and(|instant| instant.elapsed() < Duration::from_secs(15));
        let attempts = if recently_closed { 10 } else { 1 };
        for attempt in 0..attempts {
            match crate::can::device::list_devices() {
                Ok(devices) if !devices.is_empty() || attempt + 1 == attempts => {
                    return Ok(devices);
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(200)),
                Err(error) => return Err(format!("枚举设备失败: {error}")),
            }
        }
        Ok(Vec::new())
    }

    fn open_device(&mut self, index: usize) -> Result<crate::can::types::DeviceInfo, String> {
        if self.device.is_some() {
            return Err("设备已打开, 请先关闭后再切换".to_string());
        }
        // 关闭设备后 USB 需重新枚举 (~0.4s 宿主 / 数秒容器), 近期关闭过则重试。
        let recently_closed = self
            .last_close
            .is_some_and(|instant| instant.elapsed() < Duration::from_secs(15));
        let attempts = if recently_closed { 60 } else { 1 };
        for attempt in 0..attempts {
            match crate::can::device::open(index) {
                Ok(device) => {
                    let info = device.info().clone();
                    self.device = Some(device);
                    self.channels = [None, None];
                    self.software_filters.clear();
                    self.stats = Stats::default();
                    self.seq = 0;
                    self.rate_frames = 0;
                    self.rate_start = Instant::now();
                    self.last_close = None;
                    self.shared.clear_frames();
                    self.publish_status();
                    self.shared.log(
                        "info",
                        format!("已打开设备 #{} (固件 {})", info.index, info.fw_version),
                    );
                    return Ok(info);
                }
                Err(Error::DeviceNotFound) if attempt + 1 < attempts => {
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(error) => return Err(format!("打开设备失败: {error}")),
            }
        }
        Err("打开设备失败: 关闭后设备需要短暂重新枚举, 请稍后重试".to_string())
    }

    fn close_device(&mut self) -> Result<(), String> {
        self.finish_recording();
        let had_device = self.device.is_some();
        if let Some(device) = self.device.as_ref() {
            for channel in 0..2u8 {
                if self.channels[channel as usize].is_some() {
                    let _ = device.reset_can(channel);
                }
            }
        }
        self.channels = [None, None];
        self.software_filters.clear();
        if let Some(mut device) = self.device.take() {
            if let Err(error) = device.close() {
                self.shared.log("warn", format!("关闭设备时出错: {error}"));
            }
        }
        if had_device {
            self.last_close = Some(Instant::now());
        }
        self.stats = Stats::default();
        self.rate_frames = 0;
        self.rate_start = Instant::now();
        self.publish_status();
        self.shared.log("info", "设备已关闭");
        Ok(())
    }

    fn configure(&mut self, config: &StartConfig) -> Result<(), String> {
        config.validate()?;
        let mut channels = config.channels.clone();
        channels.sort_unstable();
        channels.dedup();
        if self.device.is_none() {
            return Err("设备未打开, 请先打开设备".to_string());
        }

        // 先停止本次要重配的通道; 未选中的通道保持原配置继续运行。
        if let Some(device) = self.device.as_ref() {
            for &channel in &channels {
                if self.channels[channel as usize].is_some() {
                    if let Err(error) = device.reset_can(channel) {
                        self.shared
                            .log("warn", format!("复位 CAN{} 时出错: {error}", channel + 1));
                    }
                }
            }
        }
        for &channel in &channels {
            self.channels[channel as usize] = None;
        }

        let mut started = Vec::new();
        for &channel in &channels {
            let result = match self.device.as_mut() {
                Some(device) => init_and_start(device, channel, config),
                None => Err(Error::NotOpen),
            };
            if let Err(error) = result {
                if let Some(device) = self.device.as_ref() {
                    for &started_channel in &started {
                        let _ = device.reset_can(started_channel);
                    }
                }
                for &started_channel in &started {
                    self.channels[started_channel as usize] = None;
                }
                self.publish_status();
                return Err(format!("启动 CAN{} 失败: {error}", channel + 1));
            }
            self.channels[channel as usize] = Some(ChannelRuntime {
                baud: config.baud,
                mode: config.mode,
                filter: config.filter,
            });
            started.push(channel);
        }

        self.software_filters = config.software_filters.clone();
        self.rate_frames = 0;
        self.rate_start = Instant::now();
        self.publish_status();
        let names = channels
            .iter()
            .map(|channel| format!("CAN{}", channel + 1))
            .collect::<Vec<_>>()
            .join(", ");
        self.shared.log(
            "info",
            format!(
                "已启动 {names}: {baud}, {mode}, 滤波 {} 条",
                config.software_filters.len(),
                baud = config.baud.label(),
                mode = mode_label(config.mode)
            ),
        );
        Ok(())
    }

    fn stop_channels(&mut self, channels: Option<&[u8]>) -> Result<(), String> {
        let targets: Vec<u8> = match channels {
            Some(channels) => {
                let mut targets = channels.to_vec();
                targets.sort_unstable();
                targets.dedup();
                targets
            }
            None => (0..2u8)
                .filter(|&channel| self.channels[channel as usize].is_some())
                .collect(),
        };
        if let Some(&bad) = targets.iter().find(|&&channel| channel > 1) {
            return Err(format!("非法通道 {bad}; 合法值为 0 或 1"));
        }
        for &channel in &targets {
            if self.channels[channel as usize].is_none() {
                continue;
            }
            if let Some(device) = self.device.as_ref() {
                if let Err(error) = device.reset_can(channel) {
                    self.shared
                        .log("warn", format!("复位 CAN{} 时出错: {error}", channel + 1));
                }
            }
            self.channels[channel as usize] = None;
        }
        if !targets.is_empty() {
            self.publish_status();
            let names = targets
                .iter()
                .map(|channel| format!("CAN{}", channel + 1))
                .collect::<Vec<_>>()
                .join(", ");
            self.shared.log("info", format!("已停止 {names}"));
        }
        Ok(())
    }

    /// 发送一帧。
    fn send_frame(&mut self, request: &SendFrameRequest) -> Result<(), String> {
        let frame = request.to_frame()?;
        let channel = request.channel;
        if self.device.is_none() {
            return Err("设备未打开, 无法发送".to_string());
        }
        if self.channels[channel as usize].is_none() {
            return Err(format!("CAN{} 未启动, 请先应用配置", channel + 1));
        }
        if self.channels[channel as usize].map(|runtime| runtime.mode) == Some(CanMode::ListenOnly)
        {
            return Err(format!("CAN{} 处于只听模式, 不能发送", channel + 1));
        }
        let result = match self.device.as_ref() {
            Some(device) => device.send_frame(channel, &frame),
            None => Err(Error::NotOpen),
        };
        result.map_err(|error| format!("发送失败: {error}"))?;
        self.stats.tx_frames += 1;
        self.publish_status();
        let detail = if frame.remote {
            "远程帧".to_string()
        } else {
            format!("{} 字节", frame.dlc)
        };
        self.shared.log(
            "info",
            format!(
                "已发送 CAN{} 0x{:X} ({detail}), 累计 {} 帧",
                channel + 1,
                frame.id,
                self.stats.tx_frames
            ),
        );
        Ok(())
    }

    fn start_recording(&mut self) -> Result<String, String> {
        if self.device.is_none() {
            return Err("设备未打开, 无法开始录制".to_string());
        }
        if let Some(recorder) = self.recorder.as_ref() {
            return Err(format!("正在录制: {}", recorder.name()));
        }
        let recorder = Recorder::create(&self.recordings_dir, now_ms())
            .map_err(|error| format!("创建录制文件失败: {error}"))?;
        let name = recorder.name().to_string();
        self.recorder = Some(recorder);
        self.stats.recorded_frames = 0;
        self.publish_status();
        self.shared.log("info", format!("开始录制: {name}"));
        Ok(name)
    }

    fn stop_recording(&mut self) -> Result<RecordingSummary, String> {
        let Some(recorder) = self.recorder.take() else {
            return Err("当前没有进行中的录制".to_string());
        };
        let name = recorder.name().to_string();
        match recorder.finish() {
            Ok(summary) => {
                self.stats.recorded_frames = summary.frames;
                self.publish_status();
                self.shared.log(
                    "info",
                    format!("录制已保存: {} ({} 帧)", summary.name, summary.frames),
                );
                Ok(summary)
            }
            Err(error) => {
                self.stats.recorded_frames = 0;
                self.publish_status();
                Err(format!("关闭录制文件 {name} 失败: {error}"))
            }
        }
    }

    /// 抽取两个通道的接收数据并分发。
    fn poll_frames(&mut self) {
        if self.device.is_none() || !self.channels.iter().any(Option::is_some) {
            return;
        }
        let mut received: Vec<(u8, CanFrame)> = Vec::new();
        let mut failure: Option<(u8, Error)> = None;
        if let Some(device) = self.device.as_ref() {
            for channel in 0..2u8 {
                if self.channels[channel as usize].is_none() {
                    continue;
                }
                match device.drain(channel, 8) {
                    Ok(frames) => {
                        received.extend(frames.into_iter().map(|frame| (channel, frame)));
                    }
                    Err(Error::Timeout) => {}
                    Err(error) => {
                        failure = Some((channel, error));
                        break;
                    }
                }
            }
        }
        if let Some((channel, error)) = failure {
            self.channels[channel as usize] = None;
            self.shared
                .log("error", format!("CAN{} 接收失败: {error}", channel + 1));
            if matches!(&error, Error::NoDevice) {
                self.disconnect();
                return;
            }
        }
        if received.is_empty() {
            return;
        }
        let now = now_ms();
        let mut batch = Vec::with_capacity(received.len());
        for (channel, frame) in received {
            self.ingest(channel, &frame, now, &mut batch);
        }
        self.shared.push_frames(batch);
    }

    fn ingest(
        &mut self,
        channel: u8,
        frame: &CanFrame,
        now_ms: u64,
        batch: &mut Vec<crate::can::types::FrameDto>,
    ) {
        if !self.software_filters.is_empty()
            && !self
                .software_filters
                .iter()
                .any(|filter| filter.matches(frame))
        {
            self.stats.filtered_frames += 1;
            return;
        }
        self.stats.rx_frames += 1;
        self.rate_frames += 1;
        self.seq += 1;
        let dto = crate::can::types::FrameDto::new(self.seq, now_ms, channel, frame);
        if let Some(recorder) = self.recorder.as_mut() {
            if let Err(error) = recorder.write(&dto) {
                self.shared
                    .log("error", format!("写入录制文件失败: {error}; 已停止录制"));
                self.recorder = None;
                self.publish_status();
            }
        }
        self.stats.recorded_frames = self.recorder.as_ref().map_or(0, Recorder::frames);
        batch.push(dto);
    }

    /// 设备意外断开: 释放句柄并更新状态, 保留已接收帧供查看。
    fn disconnect(&mut self) {
        if let Some(mut device) = self.device.take() {
            let _ = device.close();
        }
        self.channels = [None, None];
        self.software_filters.clear();
        self.finish_recording();
        self.last_close = Some(Instant::now());
        self.publish_status();
        self.shared.log("error", "设备已断开, 请重新连接");
    }

    /// flush 并关闭当前录制文件 (不发布状态, 由调用方负责)。
    fn finish_recording(&mut self) {
        let Some(recorder) = self.recorder.take() else {
            return;
        };
        let name = recorder.name().to_string();
        match recorder.finish() {
            Ok(summary) => self.shared.log(
                "info",
                format!("录制已保存: {} ({} 帧)", summary.name, summary.frames),
            ),
            Err(error) => self
                .shared
                .log("error", format!("保存录制文件 {name} 失败: {error}")),
        }
        self.stats.recorded_frames = 0;
    }

    fn shutdown(&mut self) {
        self.finish_recording();
        if let Some(mut device) = self.device.take() {
            let _ = device.close();
        }
        self.channels = [None, None];
        self.publish_status();
    }

    fn publish_periodic(&mut self) {
        if self.last_status.elapsed() < Duration::from_secs(1) {
            return;
        }
        let elapsed = self.rate_start.elapsed().as_secs_f64().max(0.001);
        self.stats.rx_rate = self.rate_frames as f64 / elapsed;
        self.rate_frames = 0;
        self.rate_start = Instant::now();
        self.stats.recorded_frames = self.recorder.as_ref().map_or(0, Recorder::frames);
        self.publish_status();
        self.last_status = Instant::now();
    }

    fn publish_status(&self) {
        self.shared.set_status(self.status());
    }

    fn status(&self) -> Status {
        let mut status = self.shared.status();
        status.device = DeviceStatus {
            open: self.device.is_some(),
            info: self.device.as_ref().map(|device| device.info().clone()),
        };
        status.channels = (0..2usize)
            .map(|index| self.channel_status(index))
            .collect();
        status.software_filters = self.software_filters.clone();
        status.recording = RecordingStatus {
            active: self.recorder.is_some(),
            file: self
                .recorder
                .as_ref()
                .map(|recorder| recorder.name().to_string()),
            frames: self.recorder.as_ref().map_or(0, Recorder::frames),
            started_at_ms: self.recorder.as_ref().map(Recorder::started_at_ms),
        };
        status.stats = self.stats.clone();
        status
    }

    fn channel_status(&self, index: usize) -> ChannelStatus {
        match self.channels[index] {
            Some(runtime) => ChannelStatus {
                index: index as u8,
                running: true,
                baud: Some(runtime.baud),
                mode: Some(runtime.mode),
                filter: Some(runtime.filter),
            },
            None => ChannelStatus {
                index: index as u8,
                running: false,
                baud: None,
                mode: None,
                filter: None,
            },
        }
    }
}

fn init_and_start(device: &mut UsbCan, channel: u8, config: &StartConfig) -> Result<(), Error> {
    device.init_can(channel, config.baud, config.mode, &config.filter)?;
    device.start_can(channel)?;
    let _ = device.clear_buffer(channel);
    Ok(())
}

fn mode_label(mode: CanMode) -> &'static str {
    match mode {
        CanMode::Normal => "正常模式",
        CanMode::ListenOnly => "只听模式",
        CanMode::SelfTest => "自测模式",
    }
}

fn send<T>(reply: Reply<T>, result: Result<T, String>) {
    let _ = reply.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::can::types::SoftwareFilter;
    use crate::state::ServerInfo;

    fn test_worker(directory: &std::path::Path) -> Worker {
        Worker::new(
            SharedState::new(ServerInfo {
                version: "test".to_string(),
                data_dir: directory.display().to_string(),
            }),
            directory.join("recordings"),
        )
    }

    fn frame(id: u32) -> CanFrame {
        CanFrame {
            id,
            dlc: 2,
            data: [0xAA, 0xBB, 0, 0, 0, 0, 0, 0],
            ..Default::default()
        }
    }

    #[test]
    fn ingest_writes_recording_and_updates_stats() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        let recorder = Recorder::create(&worker.recordings_dir, 0).unwrap();
        worker.recorder = Some(recorder);

        let mut batch = Vec::new();
        worker.ingest(0, &frame(0x123), 1_700_000_000_000, &mut batch);

        assert_eq!(worker.stats.rx_frames, 1);
        assert_eq!(worker.stats.filtered_frames, 0);
        assert_eq!(worker.stats.recorded_frames, 1);
        assert_eq!(worker.seq, 1);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].channel, 0);
        assert_eq!(batch[0].data, "AA BB");

        let summary = worker.recorder.take().unwrap().finish().unwrap();
        assert_eq!(summary.frames, 1);
        let path = directory.path().join("recordings").join(&summary.name);
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains(",1,291,0x123,0,0,2,AA BB"));
    }

    #[test]
    fn ingest_applies_software_filters() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        worker.software_filters = vec![SoftwareFilter {
            extended: false,
            start: 0x100,
            end: 0x1FF,
        }];

        let mut batch = Vec::new();
        worker.ingest(0, &frame(0x200), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.filtered_frames, 1);
        assert_eq!(worker.stats.rx_frames, 0);
        assert!(batch.is_empty());

        worker.ingest(0, &frame(0x123), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.filtered_frames, 1);
        assert_eq!(worker.stats.rx_frames, 1);
        assert_eq!(batch.len(), 1);
    }
}
