//! CAN 工作线程: 独占 USB 设备与 SocketCAN 链路, 串行处理配置/录制命令并持续抽取接收帧。
//!
//! 上层只通过 [`Box<dyn CanChannel>`] 操作通道; USB 与 SocketCAN 的差异收敛在
//! 各自驱动实现里, 工作线程只在生命周期与状态映射处区分来源。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::can::socketcan::{self, SocketCanLink};
use crate::can::types::{
    CanFrame, CanMode, ChannelSource, FilterUpdateRequest, LinkList, SendFrameRequest,
    SocketCanConfig, SocketCanLinkInfo, SoftwareFilter, StartConfig, UsbChannelConfig, MAX_CHANNEL,
};
use crate::can::Error;
use crate::can::UsbCanBus;
use crate::can::{CanChannel, ChannelConfig};
use crate::service::recorder::{Recorder, RecordingSummary};
use crate::service::{now_ms, Command, Reply};
use crate::state::{ChannelStatus, DeviceStatus, RecordingStatus, SharedState, Stats, Status};

/// USB 通道数; 通道 `0..USB_CHANNELS` 固定属于 USB 设备。
const USB_CHANNELS: u8 = 2;
/// USB 通道每轮最多读取的传输次数。
const USB_READ_BATCH: usize = 8;
/// 单条 SocketCAN 链路每轮最多读取的帧数。
const LINK_READ_BATCH: usize = 64;
/// SocketCAN 链路的第一个通道 id。
const FIRST_LINK_ID: u8 = 2;

/// 一个统一通道槽位: USB 通道与 SocketCAN 链路共用同一形状。
///
/// 槽位在进程内保留: 停止只释放 `channel`, id 不复用。`bitrate`/`state` 是
/// SocketCAN 未运行时的展示值; 运行中由 [`CanChannel::config`] 提供。
struct Slot {
    id: u8,
    source: ChannelSource,
    name: String,
    channel: Option<Box<dyn CanChannel>>,
    bitrate: Option<u64>,
    state: Option<String>,
    software_filters: Vec<SoftwareFilter>,
}

impl Slot {
    fn usb(index: u8) -> Self {
        Self {
            id: index,
            source: ChannelSource::Usb,
            name: format!("CAN{}", index + 1),
            channel: None,
            bitrate: None,
            state: None,
            software_filters: Vec::new(),
        }
    }

    fn socketcan(id: u8, name: String, bitrate: Option<u64>, state: String) -> Self {
        Self {
            id,
            source: ChannelSource::SocketCan,
            name,
            channel: None,
            bitrate,
            state: Some(state),
            software_filters: Vec::new(),
        }
    }

    fn is_running(&self) -> bool {
        self.channel.is_some()
    }
}

/// 工作线程内部状态。
pub(crate) struct Worker {
    shared: Arc<SharedState>,
    recordings_dir: PathBuf,
    usb: Option<UsbCanBus>,
    slots: Vec<Slot>,
    next_link_id: u8,
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
            usb: None,
            slots: vec![Slot::usb(0), Slot::usb(1)],
            next_link_id: FIRST_LINK_ID,
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
            let wait = if self.has_running() {
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
                let result = self.list_devices();
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
            Command::SetRecordingsDir { path, reply } => {
                let result = self.set_recordings_dir(path);
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
            Command::UpdateFilters { request, reply } => {
                let result = self.update_filters(&request);
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

    /// 任一通道仍在运行。
    fn has_running(&self) -> bool {
        self.slots.iter().any(Slot::is_running)
    }

    /// 枚举 USB 设备与 SocketCAN 链路。
    fn list_devices(&mut self) -> Result<LinkList, String> {
        /* 刷新列表时校验已打开的句柄, 拔出后立即释放, 避免返回陈旧设备。 */
        if self.usb.as_ref().is_some_and(|bus| !bus.is_present()) {
            self.shared.log("warn", "USB 设备已断开, 已释放设备句柄");
            self.disconnect();
        }
        let devices = self.list_devices_with_retry()?;
        self.refresh_links(true);
        Ok(LinkList {
            devices,
            socketcan: self.link_infos(),
        })
    }

    /// 用 sysfs 结果刷新链路注册表; `add_new` 为真时为新发现的接口分配 id。
    fn refresh_links(&mut self, add_new: bool) {
        for info in socketcan::list_interfaces(Path::new(socketcan::SYSFS_NET)) {
            let state = socketcan::state_label(info.up).to_string();
            if let Some(slot) = self
                .slots
                .iter_mut()
                .find(|slot| slot.source == ChannelSource::SocketCan && slot.name == info.name)
            {
                slot.bitrate = info.bitrate;
                slot.state = Some(state);
                continue;
            }
            if !add_new {
                continue;
            }
            match self.allocate_link_id() {
                Ok(id) => self
                    .slots
                    .push(Slot::socketcan(id, info.name, info.bitrate, state)),
                Err(error) => {
                    self.shared.log("warn", error);
                    return;
                }
            }
        }
    }

    /// 分配一个从未使用过的 SocketCAN 通道 id。
    fn allocate_link_id(&mut self) -> Result<u8, String> {
        if self.next_link_id > MAX_CHANNEL {
            return Err(format!(
                "SocketCAN 链路数量已达上限 {} 条",
                usize::from(MAX_CHANNEL - FIRST_LINK_ID + 1)
            ));
        }
        let id = self.next_link_id;
        self.next_link_id += 1;
        Ok(id)
    }

    fn link_infos(&self) -> Vec<SocketCanLinkInfo> {
        self.slots
            .iter()
            .filter(|slot| slot.source == ChannelSource::SocketCan)
            .map(|slot| SocketCanLinkInfo {
                name: slot.name.clone(),
                channel: slot.id,
                bitrate: slot.bitrate,
                state: slot.state.clone().unwrap_or_else(|| "unknown".to_string()),
                running: slot.is_running(),
            })
            .collect()
    }

    /// 按名字找到链路条目, 不存在时注册一个 (未运行)。
    fn ensure_link(&mut self, name: &str) -> Result<usize, String> {
        if let Some(index) = self
            .slots
            .iter()
            .position(|slot| slot.source == ChannelSource::SocketCan && slot.name == name)
        {
            return Ok(index);
        }
        socketcan::validate_name(name)?;
        let info = socketcan::list_interfaces(Path::new(socketcan::SYSFS_NET))
            .into_iter()
            .find(|info| info.name == name);
        let id = self.allocate_link_id()?;
        let state = info.as_ref().map_or_else(
            || "unknown".to_string(),
            |info| socketcan::state_label(info.up).to_string(),
        );
        self.slots.push(Slot::socketcan(
            id,
            name.to_string(),
            info.and_then(|info| info.bitrate),
            state,
        ));
        Ok(self.slots.len() - 1)
    }

    /// 枚举设备。刚关闭过设备时 USB 需要重新枚举, 做短暂重试。
    fn list_devices_with_retry(&self) -> Result<Vec<crate::can::types::DeviceInfo>, String> {
        let recently_closed = self
            .last_close
            .is_some_and(|instant| instant.elapsed() < Duration::from_secs(15));
        let attempts = if recently_closed { 10 } else { 1 };
        for attempt in 0..attempts {
            match UsbCanBus::list_devices() {
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
        if self.usb.is_some() {
            if self.usb.as_ref().is_some_and(|bus| bus.is_present()) {
                return Err("设备已打开, 请先关闭后再切换".to_string());
            }
            self.shared
                .log("warn", "USB 设备已断开, 释放旧句柄后重新打开");
            self.disconnect();
        }
        // 关闭设备后 USB 需重新枚举 (~0.4s 宿主 / 数秒容器), 近期关闭过则重试。
        let recently_closed = self
            .last_close
            .is_some_and(|instant| instant.elapsed() < Duration::from_secs(15));
        let attempts = if recently_closed { 60 } else { 1 };
        for attempt in 0..attempts {
            match UsbCanBus::open(index) {
                Ok(bus) => {
                    let info = bus.info().clone();
                    self.usb = Some(bus);
                    self.reset_usb_slots();
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
        // USB 关闭不应打断仍在运行的 SocketCAN 链路, 因此只在没有链路运行时收尾录制。
        if !self.has_running_link() {
            self.finish_recording();
        }
        let had_device = self.usb.is_some();
        for index in 0..self.slots.len() {
            if self.slots[index].source != ChannelSource::Usb {
                continue;
            }
            if self.slots[index].channel.is_some() {
                if let Some(channel) = self.slots[index].channel.as_mut() {
                    if let Err(error) = channel.stop() {
                        let id = self.slots[index].id;
                        self.shared
                            .log("warn", format!("复位 CAN{} 时出错: {error}", id + 1));
                    }
                }
                self.clear_usb_channel(index);
            }
        }
        if let Some(mut bus) = self.usb.take() {
            if let Err(error) = bus.close() {
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
        // 去重并在请求顺序内保留首次出现的配置 (validate 已拒绝重复的 USB 通道)。
        let mut usb_channels: Vec<UsbChannelConfig> = Vec::new();
        for entry in &config.usb {
            if !usb_channels.iter().any(|seen| seen.index == entry.index) {
                usb_channels.push(entry.clone());
            }
        }
        let mut links: Vec<&SocketCanConfig> = Vec::new();
        for entry in &config.socketcan {
            if !links.iter().any(|seen| seen.name == entry.name) {
                links.push(entry);
            }
        }
        // 句柄可能因拔插失效; 启动前校验并尝试重新打开。
        if !usb_channels.is_empty() && self.usb.as_ref().is_some_and(|bus| !bus.is_present()) {
            let index = self.usb.as_ref().map_or(0, UsbCanBus::index);
            self.shared.log("warn", "USB 设备已断开, 尝试重新打开");
            self.disconnect();
            if let Err(error) = self.open_device(index) {
                self.publish_status();
                return Err(error);
            }
        }

        // USB 通道只在本次请求真的要配置时才要求设备已打开; SocketCAN 可独立启动。
        if !usb_channels.is_empty() && self.usb.is_none() {
            return Err("设备未打开, 请先打开设备".to_string());
        }

        // 先停止本次要重配的 USB 通道; 未选中的通道保持原配置继续运行。
        for entry in &usb_channels {
            let Some(index) = self.slots.iter().position(|slot| slot.id == entry.index) else {
                continue;
            };
            if self.slots[index].channel.is_some() {
                if let Some(channel) = self.slots[index].channel.as_mut() {
                    if let Err(error) = channel.stop() {
                        self.shared.log(
                            "warn",
                            format!("复位 CAN{} 时出错: {error}", entry.index + 1),
                        );
                    }
                }
                self.clear_usb_channel(index);
            }
        }

        let mut started_usb: Vec<u8> = Vec::new();
        for entry in &usb_channels {
            let channel = entry.index;
            let name = format!("CAN{}", channel + 1);
            // 每个 USB 通道使用自己的波特率与硬件滤波初始化。
            let result = match self.usb.as_ref() {
                Some(bus) => bus.open_channel(channel, entry.baud, config.mode, entry.filter, name),
                None => Err(Error::NotOpen.to_string()),
            };
            match result {
                Ok(opened) => {
                    let index = self
                        .slots
                        .iter()
                        .position(|slot| slot.id == channel)
                        .expect("USB 槽位固定存在");
                    self.slots[index].channel = Some(opened);
                    self.slots[index].software_filters = entry.software_filters.clone();
                    started_usb.push(channel);
                }
                Err(error) => {
                    let disconnected = self.usb.as_ref().is_some_and(|bus| !bus.is_present());
                    self.rollback_config(&started_usb, &[]);
                    if disconnected {
                        self.disconnect();
                    }
                    self.publish_status();
                    return Err(format!("启动 CAN{} 失败: {error}", channel + 1));
                }
            }
        }

        let mut started_links: Vec<usize> = Vec::new();
        for entry in &links {
            let name = entry.name.as_str();
            let bitrate = entry.bitrate_or_default();
            let index = match self.ensure_link(name) {
                Ok(index) => index,
                Err(error) => {
                    self.rollback_config(&started_usb, &started_links);
                    self.publish_status();
                    return Err(error);
                }
            };
            // 已 UP 的接口不做任何特权操作; 未 UP 时按该条目自己的速率自动启用。
            if let Err(error) = socketcan::bring_up(name, bitrate) {
                self.rollback_config(&started_usb, &started_links);
                self.publish_status();
                return Err(error);
            }
            // 接口可能刚被启用: 尽力刷新 sysfs 可见链路的 state/bitrate (不新增注册项),
            // 这样即使随后打开 socket 失败, 注册表状态也反映真实接口状态。
            self.refresh_links(false);
            // 已运行的链路重新出现在请求中 = 关闭后重开。
            self.slots[index].channel = None;
            match SocketCanLink::open(name) {
                Ok(link) => {
                    let slot = &mut self.slots[index];
                    let bitrate = link.bitrate();
                    let state = link.state().to_string();
                    slot.bitrate = bitrate;
                    slot.state = Some(state);
                    slot.software_filters = entry.software_filters.clone();
                    slot.channel = Some(Box::new(link));
                    started_links.push(index);
                }
                Err(error) => {
                    self.rollback_config(&started_usb, &started_links);
                    self.publish_status();
                    return Err(format!("启动 SocketCAN 链路 {name} 失败: {error}"));
                }
            }
        }

        self.rate_frames = 0;
        self.rate_start = Instant::now();
        self.publish_status();
        if !usb_channels.is_empty() {
            self.shared
                .log("info", usb_start_message(&usb_channels, config.mode));
        }
        if !links.is_empty() {
            let link_names = links
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            self.shared
                .log("info", format!("已启用 SocketCAN 链路 {link_names}"));
        }
        Ok(())
    }

    /// 回滚本次请求已启动的通道与链路 (不触碰更早启动的对象)。
    fn rollback_config(&mut self, usb: &[u8], links: &[usize]) {
        for &channel in usb {
            let Some(index) = self.slots.iter().position(|slot| slot.id == channel) else {
                continue;
            };
            if let Some(opened) = self.slots[index].channel.as_mut() {
                let _ = opened.stop();
            }
            self.clear_usb_channel(index);
        }
        for &index in links {
            self.slots[index].channel = None;
        }
    }

    fn stop_channels(&mut self, channels: Option<&[u8]>) -> Result<(), String> {
        let targets: Vec<u8> = match channels {
            Some(channels) => {
                let mut targets = channels.to_vec();
                targets.sort_unstable();
                targets.dedup();
                targets
            }
            None => self
                .slots
                .iter()
                .filter(|slot| slot.is_running())
                .map(|slot| slot.id)
                .collect(),
        };
        if let Some(&bad) = targets.iter().find(|&&channel| channel > MAX_CHANNEL) {
            return Err(format!(
                "非法通道 {bad}; 合法值为 0/1 (USB) 或 2-{MAX_CHANNEL} (SocketCAN 链路)"
            ));
        }
        let mut stopped = Vec::new();
        for &channel in &targets {
            let Some(index) = self.slots.iter().position(|slot| slot.id == channel) else {
                continue;
            };
            if self.slots[index].channel.is_none() {
                continue;
            }
            let is_usb = self.slots[index].source == ChannelSource::Usb;
            let name = self.slots[index].name.clone();
            if let Some(opened) = self.slots[index].channel.as_mut() {
                if let Err(error) = opened.stop() {
                    if is_usb {
                        self.shared
                            .log("warn", format!("复位 CAN{} 时出错: {error}", channel + 1));
                    } else {
                        self.shared.log(
                            "warn",
                            format!("停止 SocketCAN 链路 {name} 时出错: {error}"),
                        );
                    }
                }
            }
            if is_usb {
                self.clear_usb_channel(index);
                stopped.push(format!("CAN{}", channel + 1));
            } else {
                self.slots[index].channel = None;
                stopped.push(name);
            }
        }
        if !stopped.is_empty() {
            self.publish_status();
            self.shared
                .log("info", format!("已停止 {}", stopped.join(", ")));
        }
        Ok(())
    }

    /// 运行中按通道实时更新滤波。
    ///
    /// 软件区间立即生效; USB 硬件验收滤波变化时通过
    /// [`CanChannel::update_hardware_filter`] 热重初始化 (不发送 ResetCAN),
    /// 实测可在不重新打开设备的情况下生效。SocketCAN 没有硬件验收滤波,
    /// 其条目里的 `filter` 会被忽略。
    fn update_filters(&mut self, request: &FilterUpdateRequest) -> Result<(), String> {
        request.validate()?;
        let has_usb = request
            .channels
            .iter()
            .any(|entry| entry.channel < USB_CHANNELS);
        if has_usb && self.usb.is_none() {
            return Err("设备未打开, 无法更新滤波".to_string());
        }
        // 先确认所有目标通道都在运行, 避免部分生效。
        for entry in &request.channels {
            let Some(slot) = self.slots.iter().find(|slot| slot.id == entry.channel) else {
                return Err(self.filter_not_running_error(entry.channel));
            };
            if !slot.is_running() {
                return Err(self.filter_not_running_error(entry.channel));
            }
        }

        let mut hardware_changed = Vec::new();
        for entry in &request.channels {
            let channel = entry.channel;
            let Some(index) = self.slots.iter().position(|slot| slot.id == channel) else {
                continue;
            };
            if self.slots[index].channel.is_none() {
                continue;
            }
            let config = self.slots[index]
                .channel
                .as_ref()
                .map(|opened| opened.config());
            if let Some(ChannelConfig::Usb {
                filter: current, ..
            }) = config
            {
                let new_filter = entry.filter.unwrap_or(current);
                if new_filter != current {
                    let result = self.slots[index]
                        .channel
                        .as_mut()
                        .expect("channel checked above")
                        .update_hardware_filter(&new_filter);
                    if let Err(error) = result {
                        self.clear_usb_channel(index);
                        self.publish_status();
                        return Err(format!("实时更新 CAN{} 硬件滤波失败: {error}", channel + 1));
                    }
                    hardware_changed.push(channel);
                }
            }
            // SocketCAN 没有硬件验收滤波: `entry.filter` 被忽略。
            self.slots[index].software_filters = entry.software_filters.clone();
        }

        self.publish_status();
        let names = request
            .channels
            .iter()
            .map(|entry| self.channel_name(entry.channel))
            .collect::<Vec<_>>()
            .join(", ");
        if hardware_changed.is_empty() {
            self.shared
                .log("info", format!("已实时更新 {names} 软件滤波, 通道未重启"));
        } else {
            let hardware_names = hardware_changed
                .iter()
                .map(|&channel| self.channel_name(channel))
                .collect::<Vec<_>>()
                .join(", ");
            self.shared.log(
                "info",
                format!("已实时更新 {names} 滤波: 硬件热重初始化 {hardware_names}"),
            );
        }
        Ok(())
    }

    /// 发送一帧: 统一通过槽位的 [`CanChannel`] 写出。
    fn send_frame(&mut self, request: &SendFrameRequest) -> Result<(), String> {
        let frame = request.to_frame()?;
        let channel = request.channel;
        if channel < USB_CHANNELS {
            if self.usb.is_none() {
                return Err("设备未打开, 无法发送".to_string());
            }
            if !self.usb_channel_alive(channel) {
                self.disconnect();
                return Err("设备已断开, 请重新连接".to_string());
            }
        }
        let Some(index) = self.slots.iter().position(|slot| slot.id == channel) else {
            return Err(self.send_not_running_error(channel));
        };
        let Some(config) = self.slots[index]
            .channel
            .as_ref()
            .map(|opened| opened.config())
        else {
            return Err(self.send_not_running_error(channel));
        };
        if let ChannelConfig::Usb {
            mode: CanMode::ListenOnly,
            ..
        } = config
        {
            return Err(format!("CAN{} 处于只听模式, 不能发送", channel + 1));
        }
        let name = self.slots[index].name.clone();
        let write_result = self.slots[index]
            .channel
            .as_mut()
            .expect("channel checked above")
            .write(&frame);
        if let Err(error) = write_result {
            if self.slots[index].source == ChannelSource::Usb {
                if self.usb.as_ref().is_some_and(|bus| !bus.is_present()) {
                    self.disconnect();
                }
                return Err(format!("发送失败: {error}"));
            }
            return Err(format!("发送到 SocketCAN 链路 {name} 失败: {error}"));
        }
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
                "已发送 {name} 0x{:X} ({detail}), 累计 {} 帧",
                frame.id, self.stats.tx_frames
            ),
        );
        Ok(())
    }

    /// 切换录制目录: 只影响下一次 `Recorder::create`, 已打开的文件继续写到原路径。
    fn set_recordings_dir(&mut self, path: PathBuf) -> Result<(), String> {
        let display = path.display().to_string();
        self.recordings_dir = path;
        self.shared
            .log("info", format!("录制目录已切换为 {display}"));
        Ok(())
    }

    fn start_recording(&mut self) -> Result<String, String> {
        // 录制与传输介质解耦: 只要还有任一运行中的通道/链路即可录制。
        if !self.has_running() {
            return Err("没有运行中的链路，无法开始录制".to_string());
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

    /// 抽取全部运行中通道的接收数据并分发。
    fn poll_frames(&mut self) {
        if !self.has_running() {
            return;
        }
        let mut received: Vec<(u8, CanFrame)> = Vec::new();
        let mut usb_failed = false;
        for index in 0..self.slots.len() {
            if self.slots[index].channel.is_none() {
                continue;
            }
            let is_usb = self.slots[index].source == ChannelSource::Usb;
            if is_usb && usb_failed {
                continue;
            }
            let batch = if is_usb {
                USB_READ_BATCH
            } else {
                LINK_READ_BATCH
            };
            let read_result = self.slots[index]
                .channel
                .as_mut()
                .map(|opened| opened.read(batch));
            match read_result {
                Some(Ok(frames)) => {
                    let id = self.slots[index].id;
                    received.extend(frames.into_iter().map(|frame| (id, frame)));
                }
                Some(Err(error)) => {
                    let id = self.slots[index].id;
                    let name = self.slots[index].name.clone();
                    if is_usb {
                        self.clear_usb_channel(index);
                        self.shared
                            .log("error", format!("CAN{} 接收失败: {error}", id + 1));
                        if self.usb.as_ref().is_some_and(|bus| !bus.is_present()) {
                            self.disconnect();
                            return;
                        }
                        usb_failed = true;
                    } else {
                        // 单条链路失败只关闭该链路, 不影响 USB 与其它链路。
                        self.slots[index].channel = None;
                        self.shared
                            .log("error", format!("SocketCAN 链路 {name} 接收失败: {error}"));
                    }
                }
                None => {}
            }
        }
        if received.is_empty() {
            return;
        }
        let now = now_ms();
        let mut batch = Vec::with_capacity(received.len());
        for (channel, frame) in received {
            let link = self.channel_name(channel);
            self.ingest(channel, &link, &frame, now, &mut batch);
        }
        self.shared.push_frames(batch);
    }

    /// 通道 id → 展示/录制用名字。
    fn channel_name(&self, channel: u8) -> String {
        self.slots
            .iter()
            .find(|slot| slot.id == channel)
            .map_or_else(|| format!("CH{channel}"), |slot| slot.name.clone())
    }

    /// USB 通道是否在线: 优先探测该通道句柄, 未运行时退化为总线探测。
    fn usb_channel_alive(&self, channel: u8) -> bool {
        if let Some(opened) = self
            .slots
            .iter()
            .find(|slot| slot.id == channel)
            .and_then(|slot| slot.channel.as_ref())
        {
            return opened.is_alive();
        }
        self.usb.as_ref().is_some_and(UsbCanBus::is_present)
    }

    /// USB 通道未启动时的错误文案 (保持既有措辞)。
    fn filter_not_running_error(&self, channel: u8) -> String {
        if channel < USB_CHANNELS {
            format!("CAN{} 未启动; 实时滤波只能作用于运行中的通道", channel + 1)
        } else {
            let label = self.channel_name(channel);
            format!("SocketCAN 链路 {label} 未启动; 实时滤波只能作用于运行中的通道")
        }
    }

    /// 发送目标未启动时的错误文案 (保持既有措辞)。
    fn send_not_running_error(&self, channel: u8) -> String {
        if channel < USB_CHANNELS {
            format!("CAN{} 未启动, 请先应用配置", channel + 1)
        } else {
            let label = self
                .slots
                .iter()
                .find(|slot| slot.id == channel)
                .map_or_else(|| format!("id {channel}"), |slot| slot.name.clone());
            format!("SocketCAN 链路 {label} 未启动, 请先应用配置")
        }
    }

    /// 释放 USB 通道并清空其区间 (停止后的 USB 状态不保留软件滤波)。
    fn clear_usb_channel(&mut self, index: usize) {
        self.slots[index].channel = None;
        self.slots[index].software_filters.clear();
    }

    /// 是否仍有运行中的 SocketCAN 链路。
    fn has_running_link(&self) -> bool {
        self.slots
            .iter()
            .any(|slot| slot.source == ChannelSource::SocketCan && slot.is_running())
    }

    /// 打开设备时重置两个 USB 槽位 (保留名称与 id)。
    fn reset_usb_slots(&mut self) {
        for index in 0..self.slots.len() {
            if self.slots[index].source == ChannelSource::Usb {
                self.clear_usb_channel(index);
            }
        }
    }

    /// 取通道当前生效的应用层区间; 通道不在运行时返回空切片 (接收全部)。
    fn channel_software_filters(&self, channel: u8) -> &[SoftwareFilter] {
        if channel < USB_CHANNELS {
            return self
                .slots
                .iter()
                .find(|slot| slot.id == channel)
                .map_or(&[][..], |slot| {
                    if slot.is_running() {
                        slot.software_filters.as_slice()
                    } else {
                        &[]
                    }
                });
        }
        self.slots
            .iter()
            .find(|slot| slot.id == channel)
            .map_or(&[][..], |slot| slot.software_filters.as_slice())
    }

    fn ingest(
        &mut self,
        channel: u8,
        link: &str,
        frame: &CanFrame,
        now_ms: u64,
        batch: &mut Vec<crate::can::types::FrameDto>,
    ) {
        let accepted = {
            let filters = self.channel_software_filters(channel);
            filters.is_empty() || filters.iter().any(|filter| filter.matches(frame))
        };
        if !accepted {
            self.stats.filtered_frames += 1;
            return;
        }
        self.stats.rx_frames += 1;
        self.rate_frames += 1;
        self.seq += 1;
        let dto = crate::can::types::FrameDto::new(self.seq, now_ms, channel, frame);
        if let Some(recorder) = self.recorder.as_mut() {
            if let Err(error) = recorder.write(&dto, link) {
                self.shared
                    .log("error", format!("写入录制文件失败: {error}; 已停止录制"));
                self.recorder = None;
                self.publish_status();
            }
        }
        self.stats.recorded_frames = self.recorder.as_ref().map_or(0, Recorder::frames);
        batch.push(dto);
    }

    /// 设备意外断开: 释放 USB 句柄并更新状态, 保留已接收帧与 SocketCAN 链路。
    fn disconnect(&mut self) {
        if let Some(mut bus) = self.usb.take() {
            let _ = bus.close();
        }
        self.reset_usb_slots();
        if !self.has_running_link() {
            self.finish_recording();
        }
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
        if let Some(mut bus) = self.usb.take() {
            let _ = bus.close();
        }
        self.reset_usb_slots();
        for slot in &mut self.slots {
            slot.channel = None;
        }
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
            open: self.usb.is_some(),
            info: self.usb.as_ref().map(|bus| bus.info().clone()),
        };
        status.channels = self.slots.iter().map(slot_status).collect();
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
}

/// 槽位 → HTTP/WS 状态。运行中的通道以 [`CanChannel::config`] 为准。
fn slot_status(slot: &Slot) -> ChannelStatus {
    match slot.channel.as_ref().map(|channel| channel.config()) {
        Some(ChannelConfig::Usb { baud, mode, filter }) => ChannelStatus {
            index: slot.id,
            source: ChannelSource::Usb,
            name: slot.name.clone(),
            running: true,
            baud: Some(baud),
            mode: Some(mode),
            filter: Some(filter),
            bitrate: None,
            state: None,
            software_filters: slot.software_filters.clone(),
        },
        Some(ChannelConfig::SocketCan { bitrate, state }) => ChannelStatus {
            index: slot.id,
            source: ChannelSource::SocketCan,
            name: slot.name.clone(),
            running: true,
            baud: None,
            mode: None,
            filter: None,
            /* 运行中接口的速率/状态优先取注册表(sysfs 刷新), 缺失时回退打开时快照。 */
            bitrate: slot.bitrate.or(bitrate),
            state: slot.state.clone().or(Some(state)),
            software_filters: slot.software_filters.clone(),
        },
        None => ChannelStatus {
            index: slot.id,
            source: slot.source,
            name: slot.name.clone(),
            running: false,
            baud: None,
            mode: None,
            filter: None,
            bitrate: if slot.source == ChannelSource::Usb {
                None
            } else {
                slot.bitrate
            },
            state: if slot.source == ChannelSource::Usb {
                None
            } else {
                slot.state.clone()
            },
            software_filters: if slot.source == ChannelSource::Usb {
                Vec::new()
            } else {
                slot.software_filters.clone()
            },
        },
    }
}

fn mode_label(mode: CanMode) -> &'static str {
    match mode {
        CanMode::Normal => "正常模式",
        CanMode::ListenOnly => "只听模式",
        CanMode::SelfTest => "自测模式",
    }
}

/// USB 启动日志: 按通道列出各自的速率, 如 `已启动 USB CAN1 (500k), CAN2 (250k)`。
fn usb_start_message(channels: &[UsbChannelConfig], mode: CanMode) -> String {
    let names = channels
        .iter()
        .map(|entry| format!("CAN{} ({})", entry.index + 1, entry.baud.short_label()))
        .collect::<Vec<_>>()
        .join(", ");
    format!("已启动 USB {names}: {}", mode_label(mode))
}

fn send<T>(reply: Reply<T>, result: Result<T, String>) {
    let _ = reply.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::can::types::{BaudRate, HardwareFilter, SoftwareFilter};
    use crate::state::ServerInfo;
    use std::sync::Mutex;

    fn test_worker(directory: &std::path::Path) -> Worker {
        Worker::new(
            SharedState::new(ServerInfo {
                version: "test".to_string(),
                data_dir: directory.display().to_string(),
                recordings_dir: directory.join("recordings").display().to_string(),
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
        worker.ingest(0, "CAN1", &frame(0x123), 1_700_000_000_000, &mut batch);

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
        assert!(content.contains("channel,link,id,id_hex"));
        assert!(content.contains(",1,CAN1,291,0x123,0,0,2,AA BB"));
    }

    fn set_filters(worker: &mut Worker, id: u8, filters: Vec<SoftwareFilter>) {
        let index = worker
            .slots
            .iter()
            .position(|slot| slot.id == id)
            .expect("slot");
        worker.slots[index].software_filters = filters;
    }

    #[test]
    fn ingest_applies_per_channel_software_filters() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        worker.slots[0].channel = Some(Box::new(FakeChannel::new(
            "CAN1",
            ChannelSource::Usb,
            ChannelConfig::Usb {
                baud: BaudRate::Kbps500,
                mode: CanMode::Normal,
                filter: HardwareFilter::default(),
            },
            vec![],
        )));
        set_filters(
            &mut worker,
            0,
            vec![SoftwareFilter {
                extended: false,
                start: 0x100,
                end: 0x1FF,
            }],
        );
        // 通道 1 没有区间 (接收全部)。
        worker.slots[1].channel = Some(Box::new(FakeChannel::new(
            "CAN2",
            ChannelSource::Usb,
            ChannelConfig::Usb {
                baud: BaudRate::Kbps250,
                mode: CanMode::Normal,
                filter: HardwareFilter::default(),
            },
            vec![],
        )));
        worker.slots.push(Slot {
            id: 2,
            source: ChannelSource::SocketCan,
            name: "can0".to_string(),
            channel: None,
            bitrate: None,
            state: Some("up".to_string()),
            software_filters: vec![SoftwareFilter {
                extended: false,
                start: 0x200,
                end: 0x2FF,
            }],
        });

        let mut batch = Vec::new();
        worker.ingest(0, "CAN1", &frame(0x200), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.filtered_frames, 1);
        assert_eq!(worker.stats.rx_frames, 0);
        assert!(batch.is_empty());

        worker.ingest(0, "CAN1", &frame(0x123), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.rx_frames, 1);
        assert_eq!(batch.len(), 1);

        // 同一帧在通道 1 被放行, 说明区间是按通道独立的。
        worker.ingest(1, "CAN2", &frame(0x200), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.rx_frames, 2);
        assert_eq!(batch.len(), 2);

        // SocketCAN 链路只接受自己区间内的帧。
        worker.ingest(2, "can0", &frame(0x123), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.filtered_frames, 2);
        worker.ingest(2, "can0", &frame(0x234), 1_700_000_000_000, &mut batch);
        assert_eq!(worker.stats.rx_frames, 3);
    }

    #[test]
    fn socketcan_link_ids_start_at_two_and_are_not_reused() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        assert_eq!(worker.allocate_link_id().unwrap(), 2);
        assert_eq!(worker.allocate_link_id().unwrap(), 3);
        worker.next_link_id = MAX_CHANNEL;
        assert_eq!(worker.allocate_link_id().unwrap(), MAX_CHANNEL);
        assert!(worker.allocate_link_id().is_err());
    }

    #[test]
    fn status_lists_registered_socketcan_links() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        worker.slots.push(Slot {
            id: 2,
            source: ChannelSource::SocketCan,
            name: "can0".to_string(),
            channel: None,
            bitrate: Some(500_000),
            state: Some("down".to_string()),
            software_filters: vec![SoftwareFilter {
                extended: false,
                start: 0x100,
                end: 0x1FF,
            }],
        });

        let status = worker.status();
        assert_eq!(status.channels.len(), 3);
        assert_eq!(status.channels[0].name, "CAN1");
        assert_eq!(status.channels[0].source, ChannelSource::Usb);
        let link = &status.channels[2];
        assert_eq!(link.index, 2);
        assert_eq!(link.name, "can0");
        assert_eq!(link.source, ChannelSource::SocketCan);
        assert!(!link.running);
        assert_eq!(link.bitrate, Some(500_000));
        assert_eq!(link.state.as_deref(), Some("down"));
        assert!(link.baud.is_none() && link.mode.is_none() && link.filter.is_none());
        assert_eq!(link.software_filters.len(), 1);
        assert_eq!(link.software_filters[0].start, 0x100);
        // 未运行的 USB 通道也带空区间字段 (形状统一)。
        assert!(status.channels[0].software_filters.is_empty());
    }

    #[test]
    fn channel_names_fall_back_to_ch_index() {
        let directory = tempfile::tempdir().unwrap();
        let worker = test_worker(directory.path());
        assert_eq!(worker.channel_name(0), "CAN1");
        assert_eq!(worker.channel_name(1), "CAN2");
        assert_eq!(worker.channel_name(7), "CH7");
    }

    #[test]
    fn usb_start_log_lists_each_channel_rate() {
        let message = usb_start_message(
            &[
                UsbChannelConfig {
                    index: 0,
                    baud: BaudRate::Kbps500,
                    filter: HardwareFilter::default(),
                    software_filters: vec![],
                },
                UsbChannelConfig {
                    index: 1,
                    baud: BaudRate::Kbps250,
                    filter: HardwareFilter::default(),
                    software_filters: vec![],
                },
            ],
            CanMode::Normal,
        );
        assert_eq!(message, "已启动 USB CAN1 (500k), CAN2 (250k): 正常模式");
    }

    /// 可注入的假通道: 验证工作线程只通过 trait object 收发。
    struct FakeChannel {
        name: String,
        source: ChannelSource,
        config: ChannelConfig,
        incoming: Vec<CanFrame>,
        written: Arc<Mutex<Vec<u32>>>,
    }

    impl FakeChannel {
        fn new(
            name: &str,
            source: ChannelSource,
            config: ChannelConfig,
            incoming: Vec<CanFrame>,
        ) -> Self {
            Self {
                name: name.to_string(),
                source,
                config,
                incoming,
                written: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl CanChannel for FakeChannel {
        fn source(&self) -> ChannelSource {
            self.source
        }

        fn name(&self) -> &str {
            &self.name
        }

        fn config(&self) -> ChannelConfig {
            self.config.clone()
        }

        fn read(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
            let take = max.min(self.incoming.len());
            Ok(self.incoming.drain(..take).collect())
        }

        fn write(&mut self, frame: &CanFrame) -> Result<(), String> {
            self.written.lock().unwrap().push(frame.id);
            Ok(())
        }

        fn stop(&mut self) -> Result<(), String> {
            Ok(())
        }

        fn is_alive(&self) -> bool {
            true
        }

        fn update_hardware_filter(&mut self, filter: &HardwareFilter) -> Result<(), String> {
            if let ChannelConfig::Usb {
                filter: current, ..
            } = &mut self.config
            {
                *current = *filter;
            }
            Ok(())
        }
    }

    #[test]
    fn poll_and_send_use_channel_trait_object() {
        let directory = tempfile::tempdir().unwrap();
        let mut worker = test_worker(directory.path());
        let fake = FakeChannel::new(
            "can0",
            ChannelSource::SocketCan,
            ChannelConfig::SocketCan {
                bitrate: Some(500_000),
                state: "up".to_string(),
            },
            vec![frame(0x123)],
        );
        let written = Arc::clone(&fake.written);
        worker.slots.push(Slot {
            id: 2,
            source: ChannelSource::SocketCan,
            name: "can0".to_string(),
            channel: Some(Box::new(fake)),
            bitrate: None,
            state: Some("up".to_string()),
            software_filters: Vec::new(),
        });

        worker.poll_frames();
        assert_eq!(worker.stats.rx_frames, 1);
        assert_eq!(worker.shared.frames().len(), 1);

        worker
            .send_frame(&SendFrameRequest {
                channel: 2,
                id: 0x321,
                extended: false,
                remote: false,
                dlc: Some(2),
                data: "DE AD".to_string(),
            })
            .unwrap();
        assert_eq!(*written.lock().unwrap(), vec![0x321]);
        assert_eq!(worker.stats.tx_frames, 1);
        assert_eq!(worker.slots[0].id, 0);
        assert_eq!(worker.slots[1].id, 1);
        // 运行中的 SocketCAN 状态来自通道配置。
        let status = worker.status();
        assert!(status.channels[2].running);
        assert_eq!(status.channels[2].bitrate, Some(500_000));
        assert_eq!(status.channels[2].state.as_deref(), Some("up"));
    }
}
