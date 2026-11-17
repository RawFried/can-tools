//! CAN Tools: 基于 USBCAN/CANalyst-II (04d8:0053) 的 Web 上位机。
//!
//! 功能范围: 配置波特率与工作模式、设置硬件/软件滤波、实时查看并保存报文。
//! USB 访问由独立工作线程独占; HTTP/WebSocket 层只消费状态快照与事件。

#![warn(missing_docs)]

pub mod can;
pub mod logging;
pub mod paths;
pub mod server;
pub mod service;
pub mod state;
