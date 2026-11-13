//! DBC 文件解析: 提取报文与信号元数据, 供前端按定义解码。
//!
//! 解析器面向行, 只关心 `BO_`、`SG_`、`VAL_` 与 `SIG_VALTYPE_` 四类语句;
//! `VERSION`、`NS_`、`BU_`、`CM_`、`BA_`、`BA_DEF_`、`VAL_TABLE_`、`SGTYPE_`、
//! `EV_` 等段一律忽略。`//` 开头的行按注释处理。
//!
//! 错误信息带行号且为中文, 可直接展示给上传失败的用户; 解析过程不 panic。

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// DBC 文本上限 (1 MiB, 按 UTF-8 字节计)。
pub const MAX_CONTENT_BYTES: usize = 1024 * 1024;
/// 单个 DBC 文件最多允许的报文数。
pub const MAX_MESSAGES: usize = 5000;
/// 单条报文最多允许的信号数。
pub const MAX_SIGNALS_PER_MESSAGE: usize = 512;
/// 单个信号的位宽上限 (CAN FD 最大 64 位)。
pub const MAX_SIGNAL_BITS: u32 = 64;

/// 已加载的 DBC 定义。
///
/// 字段形状与 `docs/api.md` 的「DBC definition object」一致; 所有字段始终存在。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DbcDefinition {
    /// 上传时使用的文件名。
    pub name: String,
    /// 解析完成的主机时间 (UNIX 毫秒)。
    pub loaded_at_ms: u64,
    /// 报文定义列表。
    pub messages: Vec<DbcMessage>,
}

/// 一条 DBC 报文 (`BO_`)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DbcMessage {
    /// 不含扩展帧标志位的 CAN ID。
    pub id: u32,
    /// `BO_` 的 bit31 是否为 1。
    pub extended: bool,
    /// 报文名。
    pub name: String,
    /// 数据长度, 固定在 0..=8 (越界值按 8 处理)。
    pub dlc: u8,
    /// 发送节点, 保留 `Vector__XXX` 等原始名称。
    pub sender: String,
    /// 信号定义列表。
    pub signals: Vec<DbcSignal>,
}

/// 一条 DBC 信号 (`SG_`)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DbcSignal {
    /// 信号名。
    pub name: String,
    /// 起始位。
    pub start_bit: u32,
    /// 位宽。
    pub length: u32,
    /// `@1` 为 true (Intel/小端), `@0` 为 false (Motorola/大端)。
    pub little_endian: bool,
    /// 是否按二进制补码解释为有符号数。
    pub signed: bool,
    /// 物理值换算比例。
    pub factor: f64,
    /// 物理值换算偏移。
    pub offset: f64,
    /// 定义的最小物理值。
    pub min: f64,
    /// 定义的最大物理值。
    pub max: f64,
    /// 单位, 无单位时为空串。
    pub unit: String,
    /// 接收节点列表; `Vector__XXX` 原样保留。
    pub receivers: Vec<String>,
    /// 原始值类型。
    pub value_kind: DbcValueKind,
    /// 多路复用标记; 普通信号为 `None`。
    pub mux: Option<DbcMultiplexer>,
    /// `VAL_` 取值表, 无则为空。
    pub values: Vec<DbcValueEntry>,
}

/// 信号的原始值类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DbcValueKind {
    /// 无符号整数。
    Unsigned,
    /// 有符号整数。
    Signed,
    /// 32 位 IEEE 754 浮点数。
    Float,
    /// 64 位 IEEE 754 浮点数。
    Double,
}

/// 多路复用标记。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DbcMultiplexer {
    /// 该信号是否为多路选择器 (`M`)。
    pub is_multiplexer: bool,
    /// `m<N>` 中的选择值; `M` 或普通信号为 `None`。
    pub value: Option<i64>,
}

/// `VAL_` 取值表的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DbcValueEntry {
    /// 原始值, 可为负。
    pub raw: i64,
    /// 人类可读标签。
    pub label: String,
}

/// 解析 DBC 文本。
///
/// `name` 仅作为定义名透传 (通常是上传的文件名)。失败时返回带行号的中文错误。
pub fn parse(name: &str, content: &str) -> Result<DbcDefinition, String> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "DBC 内容超过 1 MiB 上限 (实际 {} 字节)",
            content.len()
        ));
    }
    let mut parser = Parser::default();
    for (index, line) in content.lines().enumerate() {
        parser.feed(index + 1, line)?;
    }
    parser.finish();
    Ok(DbcDefinition {
        name: name.to_string(),
        loaded_at_ms: now_ms(),
        messages: parser.messages,
    })
}

/// 从磁盘读取并解析 DBC 文件。
///
/// 读取失败 (不存在、无权限、非 UTF-8) 返回中文错误并带上路径。
pub fn load_file(path: &Path) -> Result<DbcDefinition, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("无法读取 DBC 文件 {}: {error}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("dbc")
        .to_string();
    parse(&name, &content)
}

#[derive(Default)]
struct Parser {
    messages: Vec<DbcMessage>,
    raw_index: HashMap<u32, usize>,
    id_index: HashMap<u32, usize>,
    values: Vec<(u32, String, Vec<DbcValueEntry>)>,
    value_types: Vec<(u32, String, u8)>,
}

impl Parser {
    fn feed(&mut self, line_number: usize, raw_line: &str) -> Result<(), String> {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("//") {
            return Ok(());
        }
        if let Some(rest) = strip_keyword(line, "BO_") {
            return self.parse_message(line_number, rest);
        }
        if let Some(rest) = strip_keyword(line, "SG_") {
            return self.parse_signal(line_number, rest);
        }
        if let Some(rest) = strip_keyword(line, "VAL_") {
            if rest.is_empty() {
                // `NS_` 段会单独列出 `VAL_` 关键字, 按无关段忽略。
                return Ok(());
            }
            return self.parse_values(line_number, rest);
        }
        if let Some(rest) = strip_keyword(line, "SIG_VALTYPE_") {
            if rest.is_empty() {
                return Ok(());
            }
            return self.parse_value_type(line_number, rest);
        }
        // 其余段 (VERSION/NS_/BS_/BU_/CM_/BA_*/VAL_TABLE_/SGTYPE_/EV_ 等) 忽略。
        Ok(())
    }

    fn parse_message(&mut self, line_number: usize, rest: &str) -> Result<(), String> {
        if self.messages.len() >= MAX_MESSAGES {
            return Err(line_error(
                line_number,
                &format!("报文数量超过 {MAX_MESSAGES} 上限"),
            ));
        }
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        if tokens.len() < 4 {
            return Err(line_error(
                line_number,
                "BO_ 报文定义格式错误, 应为 BO_ <ID> <名称>: <DLC> <发送节点>",
            ));
        }
        let raw_id = tokens[0]
            .parse::<i64>()
            .map_err(|_| line_error(line_number, &format!("报文 ID 不是数字: {}", tokens[0])))?;
        let name = tokens[1]
            .strip_suffix(':')
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                line_error(
                    line_number,
                    &format!("报文名称必须以冒号结尾: {}", tokens[1]),
                )
            })?;
        let dlc = tokens[2]
            .parse::<u32>()
            .map_err(|_| line_error(line_number, &format!("报文 DLC 不是数字: {}", tokens[2])))?;
        let sender = tokens[3..].join(" ");
        let (id, extended, key) = split_raw_id(raw_id);
        let index = self.messages.len();
        self.raw_index.entry(key).or_insert(index);
        self.id_index.entry(id).or_insert(index);
        self.messages.push(DbcMessage {
            id,
            extended,
            name: name.to_string(),
            dlc: dlc.min(8) as u8,
            sender,
            signals: Vec::new(),
        });
        Ok(())
    }

    fn parse_signal(&mut self, line_number: usize, rest: &str) -> Result<(), String> {
        let Some(message) = self.messages.last_mut() else {
            return Err(line_error(line_number, "SG_ 信号必须位于 BO_ 报文之后"));
        };
        if message.signals.len() >= MAX_SIGNALS_PER_MESSAGE {
            return Err(line_error(
                line_number,
                &format!(
                    "报文 {} 的信号数量超过 {MAX_SIGNALS_PER_MESSAGE} 上限",
                    message.name
                ),
            ));
        }
        let signal = parse_signal_body(line_number, rest)?;
        message.signals.push(signal);
        Ok(())
    }

    fn parse_values(&mut self, line_number: usize, rest: &str) -> Result<(), String> {
        let body = rest.trim_end().strip_suffix(';').unwrap_or(rest).trim();
        let tokens = tokenize(body);
        if tokens.len() < 2 {
            return Err(line_error(
                line_number,
                "VAL_ 定义不完整, 应为 VAL_ <报文ID> <信号> <值> \"<标签>\" ...;",
            ));
        }
        let raw_id = tokens[0].parse::<i64>().map_err(|_| {
            line_error(
                line_number,
                &format!("VAL_ 报文 ID 不是数字: {}", tokens[0]),
            )
        })?;
        let (_, _, key) = split_raw_id(raw_id);
        let signal_name = tokens[1].clone();
        let mut entries = Vec::new();
        let mut index = 2;
        while index < tokens.len() {
            if index + 1 >= tokens.len() {
                return Err(line_error(
                    line_number,
                    &format!("VAL_ 取值 {} 缺少标签", tokens[index]),
                ));
            }
            let raw = tokens[index].parse::<i64>().map_err(|_| {
                line_error(
                    line_number,
                    &format!("VAL_ 取值不是数字: {}", tokens[index]),
                )
            })?;
            entries.push(DbcValueEntry {
                raw,
                label: tokens[index + 1].clone(),
            });
            index += 2;
        }
        self.values.push((key, signal_name, entries));
        Ok(())
    }

    fn parse_value_type(&mut self, line_number: usize, rest: &str) -> Result<(), String> {
        let body = rest.trim_end().strip_suffix(';').unwrap_or(rest).trim();
        let (head, kind) = body.split_once(':').ok_or_else(|| {
            line_error(
                line_number,
                "SIG_VALTYPE_ 定义格式错误, 应为 SIG_VALTYPE_ <报文ID> <信号> : <1|2>;",
            )
        })?;
        let mut parts = head.split_whitespace();
        let raw_id = parts
            .next()
            .ok_or_else(|| line_error(line_number, "SIG_VALTYPE_ 缺少报文 ID"))?;
        let signal_name = parts
            .next()
            .ok_or_else(|| line_error(line_number, "SIG_VALTYPE_ 缺少信号名"))?;
        if parts.next().is_some() {
            return Err(line_error(line_number, "SIG_VALTYPE_ 冒号前存在多余字段"));
        }
        let raw_id = raw_id.parse::<i64>().map_err(|_| {
            line_error(
                line_number,
                &format!("SIG_VALTYPE_ 报文 ID 不是数字: {raw_id}"),
            )
        })?;
        let kind = kind.trim().parse::<u8>().map_err(|_| {
            line_error(
                line_number,
                &format!("SIG_VALTYPE_ 类型不是数字: {}", kind.trim()),
            )
        })?;
        if kind > 2 {
            return Err(line_error(
                line_number,
                &format!("SIG_VALTYPE_ 只支持 1 (float) 或 2 (double), 实际 {kind}"),
            ));
        }
        let (_, _, key) = split_raw_id(raw_id);
        self.value_types.push((key, signal_name.to_string(), kind));
        Ok(())
    }

    fn finish(&mut self) {
        for (key, signal_name, entries) in std::mem::take(&mut self.values) {
            if let Some(index) = self.lookup(key) {
                if let Some(signal) = self.messages[index]
                    .signals
                    .iter_mut()
                    .find(|signal| signal.name == signal_name)
                {
                    signal.values = entries;
                }
            }
        }
        for (key, signal_name, kind) in std::mem::take(&mut self.value_types) {
            if let Some(index) = self.lookup(key) {
                if let Some(signal) = self.messages[index]
                    .signals
                    .iter_mut()
                    .find(|signal| signal.name == signal_name)
                {
                    match kind {
                        1 => {
                            signal.value_kind = DbcValueKind::Float;
                            signal.signed = false;
                        }
                        2 => {
                            signal.value_kind = DbcValueKind::Double;
                            signal.signed = false;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    fn lookup(&self, key: u32) -> Option<usize> {
        self.raw_index
            .get(&key)
            .copied()
            .or_else(|| self.id_index.get(&(key & 0x1FFF_FFFF)).copied())
    }
}

fn parse_signal_body(line_number: usize, rest: &str) -> Result<DbcSignal, String> {
    let error = |message: String| line_error(line_number, &message);
    let (header, tail) = rest
        .split_once(':')
        .ok_or_else(|| error("SG_ 信号定义缺少冒号".to_string()))?;
    let mut header_parts = header.split_whitespace();
    let name = header_parts
        .next()
        .ok_or_else(|| error("SG_ 信号缺少名称".to_string()))?;
    let mux = match header_parts.next() {
        Some(token) => Some(parse_mux(line_number, name, token)?),
        None => None,
    };
    if header_parts.next().is_some() {
        return Err(error(format!("信号 {name} 的头部包含多余字段")));
    }

    let (spec, tail) = take_token(tail);
    if spec.is_empty() {
        return Err(error(format!("信号 {name} 缺少位定义")));
    }
    let (start_bit, length, little_endian, signed) = parse_bit_spec(line_number, name, spec)?;

    let (factor_offset, tail) = take_group(tail, '(', ')')
        .ok_or_else(|| error(format!("信号 {name} 缺少 (factor,offset)")))?;
    let (factor, offset) = parse_factor_offset(line_number, name, factor_offset)?;

    let (range, tail) =
        take_group(tail, '[', ']').ok_or_else(|| error(format!("信号 {name} 缺少 [min|max]")))?;
    let (min, max) = parse_range(line_number, name, range)?;

    let (unit, receivers) = parse_unit_and_receivers(line_number, name, tail)?;

    Ok(DbcSignal {
        name: name.to_string(),
        start_bit,
        length,
        little_endian,
        signed,
        factor,
        offset,
        min,
        max,
        unit,
        receivers,
        value_kind: if signed {
            DbcValueKind::Signed
        } else {
            DbcValueKind::Unsigned
        },
        mux,
        values: Vec::new(),
    })
}

fn parse_mux(line_number: usize, signal: &str, token: &str) -> Result<DbcMultiplexer, String> {
    if token == "M" {
        return Ok(DbcMultiplexer {
            is_multiplexer: true,
            value: None,
        });
    }
    if let Some(rest) = token.strip_prefix('m') {
        let (number, is_multiplexer) = match rest.strip_suffix('M') {
            Some(number) => (number, true),
            None => (rest, false),
        };
        let value = number.parse::<i64>().map_err(|_| {
            line_error(
                line_number,
                &format!("信号 {signal} 的多路标记不是数字: {token}"),
            )
        })?;
        return Ok(DbcMultiplexer {
            is_multiplexer,
            value: Some(value),
        });
    }
    Err(line_error(
        line_number,
        &format!("无法解析信号 {signal} 的多路标记: {token}"),
    ))
}

fn parse_bit_spec(
    line_number: usize,
    signal: &str,
    spec: &str,
) -> Result<(u32, u32, bool, bool), String> {
    let error = |message: String| line_error(line_number, &message);
    let (bits, order) = spec
        .split_once('@')
        .ok_or_else(|| error(format!("信号 {signal} 的位定义缺少 @: {spec}")))?;
    let (start, length) = bits
        .split_once('|')
        .ok_or_else(|| error(format!("信号 {signal} 的位定义缺少 |: {spec}")))?;
    let start_bit = start
        .trim()
        .parse::<u32>()
        .map_err(|_| error(format!("信号 {signal} 的起始位不是数字: {start}")))?;
    let length = length
        .trim()
        .parse::<u32>()
        .map_err(|_| error(format!("信号 {signal} 的位宽不是数字: {length}")))?;
    if length == 0 || length > MAX_SIGNAL_BITS {
        return Err(error(format!(
            "信号 {signal} 的位宽必须在 1-{MAX_SIGNAL_BITS} 之间, 实际 {length}"
        )));
    }
    let mut chars = order.trim().chars();
    let little_endian = match chars.next() {
        Some('0') => false,
        Some('1') => true,
        _ => {
            return Err(error(format!(
                "信号 {signal} 的字节序必须是 0 或 1: {spec}"
            )))
        }
    };
    let signed = match chars.next() {
        Some('+') => false,
        Some('-') => true,
        _ => return Err(error(format!("信号 {signal} 的符号必须是 + 或 -: {spec}"))),
    };
    if chars.next().is_some() {
        return Err(error(format!("信号 {signal} 的位定义有多余字符: {spec}")));
    }
    Ok((start_bit, length, little_endian, signed))
}

fn parse_factor_offset(
    line_number: usize,
    signal: &str,
    group: &str,
) -> Result<(f64, f64), String> {
    let error = |message: String| line_error(line_number, &message);
    let (factor, offset) = group.split_once(',').ok_or_else(|| {
        error(format!(
            "信号 {signal} 的 (factor,offset) 缺少逗号: ({group})"
        ))
    })?;
    let factor = factor.trim().parse::<f64>().map_err(|_| {
        error(format!(
            "信号 {signal} 的 factor 不是数字: {}",
            factor.trim()
        ))
    })?;
    let offset = offset.trim().parse::<f64>().map_err(|_| {
        error(format!(
            "信号 {signal} 的 offset 不是数字: {}",
            offset.trim()
        ))
    })?;
    Ok((factor, offset))
}

fn parse_range(line_number: usize, signal: &str, group: &str) -> Result<(f64, f64), String> {
    let error = |message: String| line_error(line_number, &message);
    let (min, max) = group
        .split_once('|')
        .ok_or_else(|| error(format!("信号 {signal} 的 [min|max] 缺少 |: [{group}]")))?;
    let min = min
        .trim()
        .parse::<f64>()
        .map_err(|_| error(format!("信号 {signal} 的 min 不是数字: {}", min.trim())))?;
    let max = max
        .trim()
        .parse::<f64>()
        .map_err(|_| error(format!("信号 {signal} 的 max 不是数字: {}", max.trim())))?;
    Ok((min, max))
}

fn parse_unit_and_receivers(
    line_number: usize,
    signal: &str,
    tail: &str,
) -> Result<(String, Vec<String>), String> {
    let error = |message: String| line_error(line_number, &message);
    let trimmed = tail.trim_start();
    let rest = trimmed
        .strip_prefix('"')
        .ok_or_else(|| error(format!("信号 {signal} 缺少带引号的单位")))?;
    let end = rest
        .find('"')
        .ok_or_else(|| error(format!("信号 {signal} 的单位缺少结束引号")))?;
    let unit = rest[..end].to_string();
    let receivers = rest[end + 1..]
        .split_whitespace()
        .map(str::to_string)
        .collect();
    Ok((unit, receivers))
}

fn split_raw_id(raw: i64) -> (u32, bool, u32) {
    let masked = (raw & 0xFFFF_FFFF) as u32;
    let extended = masked & 0x8000_0000 != 0;
    (masked & 0x1FFF_FFFF, extended, masked)
}

fn strip_keyword<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(keyword)?;
    if rest.is_empty() {
        Some(rest)
    } else if rest.chars().next().is_some_and(char::is_whitespace) {
        Some(rest.trim_start())
    } else {
        None
    }
}

fn take_token(input: &str) -> (&str, &str) {
    let trimmed = input.trim_start();
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    (&trimmed[..end], &trimmed[end..])
}

fn take_group(input: &str, open: char, close: char) -> Option<(&str, &str)> {
    let trimmed = input.trim_start();
    let rest = trimmed.strip_prefix(open)?;
    let end = rest.find(close)?;
    Some((&rest[..end], &rest[end + close.len_utf8()..]))
}

/// 按空白切分并保留引号内文本 (用于 `VAL_` 标签)。
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character.is_whitespace() {
            continue;
        }
        if character == '"' {
            let mut value = String::new();
            for inner in chars.by_ref() {
                if inner == '"' {
                    break;
                }
                value.push(inner);
            }
            tokens.push(value);
        } else {
            let mut token = String::new();
            token.push(character);
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() {
                    break;
                }
                token.push(next);
                chars.next();
            }
            tokens.push(token);
        }
    }
    tokens
}

fn line_error(line_number: usize, message: &str) -> String {
    format!("第 {line_number} 行: {message}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_and_extended_ids() {
        let definition = parse(
            "demo.dbc",
            "BO_ 291 Standard: 8 ECU\n\
             BO_ 2566869221 Extended: 8 ECU\n",
        )
        .unwrap();
        assert_eq!(definition.messages.len(), 2);
        assert_eq!(definition.messages[0].id, 0x123);
        assert!(!definition.messages[0].extended);
        assert_eq!(definition.messages[1].id, 0x18FF_50E5);
        assert!(definition.messages[1].extended);
    }

    #[test]
    fn parses_signal_layout_signed_factor_offset_and_units() {
        let definition = parse(
            "demo.dbc",
            "BO_ 291 EngineData: 8 ECU\n\
             \x20SG_ Speed : 0|16@1+ (0.25,10) [0|16383.75] \"rpm\" CLUSTER\n\
             \x20SG_ Torque : 23|16@0- (0.5,-1000) [-1000|1000] \"Nm\" Vector__XXX\n",
        )
        .unwrap();
        let signals = &definition.messages[0].signals;
        assert_eq!(signals.len(), 2);
        let speed = &signals[0];
        assert_eq!(speed.start_bit, 0);
        assert_eq!(speed.length, 16);
        assert!(speed.little_endian);
        assert!(!speed.signed);
        assert_eq!(speed.factor, 0.25);
        assert_eq!(speed.offset, 10.0);
        assert_eq!(speed.unit, "rpm");
        assert_eq!(speed.value_kind, DbcValueKind::Unsigned);
        assert_eq!(speed.receivers, vec!["CLUSTER".to_string()]);

        let torque = &signals[1];
        assert_eq!(torque.start_bit, 23);
        assert!(!torque.little_endian);
        assert!(torque.signed);
        assert_eq!(torque.factor, 0.5);
        assert_eq!(torque.offset, -1000.0);
        assert_eq!(torque.value_kind, DbcValueKind::Signed);
        assert_eq!(torque.receivers, vec!["Vector__XXX".to_string()]);
    }

    #[test]
    fn applies_val_table_and_sig_valtype() {
        let definition = parse(
            "demo.dbc",
            "BO_ 800 MuxData: 8 ECU\n\
             \x20SG_ Mode : 0|8@1- (1,0) [0|255] \"\" ECU\n\
             \x20SG_ FloatValue : 8|32@1+ (1,0) [0|0] \"\" ECU\n\
             \x20SG_ DoubleValue : 8|64@1+ (1,0) [0|0] \"\" ECU\n\
             VAL_ 800 Mode 0 \"Off\" 1 \"On\" -1 \"Unknown\" ;\n\
             SIG_VALTYPE_ 800 FloatValue : 1;\n\
             SIG_VALTYPE_ 800 DoubleValue : 2;\n",
        )
        .unwrap();
        let signals = &definition.messages[0].signals;
        assert_eq!(
            signals[0].values,
            vec![
                DbcValueEntry {
                    raw: 0,
                    label: "Off".to_string()
                },
                DbcValueEntry {
                    raw: 1,
                    label: "On".to_string()
                },
                DbcValueEntry {
                    raw: -1,
                    label: "Unknown".to_string()
                },
            ]
        );
        assert_eq!(signals[1].value_kind, DbcValueKind::Float);
        assert!(!signals[1].signed);
        assert_eq!(signals[2].value_kind, DbcValueKind::Double);
        assert!(!signals[2].signed);
    }

    #[test]
    fn parses_multiplexer_markers() {
        let definition = parse(
            "demo.dbc",
            "BO_ 800 MuxData: 8 ECU\n\
             \x20SG_ Selector M : 0|8@1+ (1,0) [0|3] \"\" ECU\n\
             \x20SG_ First m1 : 8|16@1+ (1,0) [0|65535] \"\" ECU\n\
             \x20SG_ Second m2M : 8|16@1+ (1,0) [0|65535] \"\" ECU\n",
        )
        .unwrap();
        let signals = &definition.messages[0].signals;
        assert_eq!(
            signals[0].mux,
            Some(DbcMultiplexer {
                is_multiplexer: true,
                value: None
            })
        );
        assert_eq!(
            signals[1].mux,
            Some(DbcMultiplexer {
                is_multiplexer: false,
                value: Some(1)
            })
        );
        assert_eq!(
            signals[2].mux,
            Some(DbcMultiplexer {
                is_multiplexer: true,
                value: Some(2)
            })
        );
    }

    #[test]
    fn handles_crlf_and_ignores_unrelated_sections() {
        let definition = parse(
            "demo.dbc",
            "VERSION \"\"\r\n\
             \r\n\
             NS_ :\r\n\
             \tCM_\r\n\
             \tBA_DEF_\r\n\
             \tVAL_\r\n\
             \tSIG_VALTYPE_\r\n\
             BS_:\r\n\
             BU_: ECU CLUSTER\r\n\
             CM_ BO_ 291 \"注释\";\r\n\
             BA_DEF_ BO_ \"GenMsgCycleTime\" INT 0 65535;\r\n\
             BO_ 291 EngineData: 8 ECU\r\n\
             \x20SG_ Speed : 0|16@1+ (0.25,0) [0|16383.75] \"rpm\" CLUSTER\r\n\
             // 这是注释行\r\n\
             SGTYPE_ 1 0 : 8 0 1 0 0 0;\r\n\
             EV_ 1 0;\r\n",
        )
        .unwrap();
        assert_eq!(definition.messages.len(), 1);
        assert_eq!(definition.messages[0].signals.len(), 1);
        assert_eq!(definition.messages[0].sender, "ECU");
    }

    #[test]
    fn reports_line_number_for_invalid_dlc() {
        let error = parse("bad.dbc", "VERSION \"\"\nBO_ 291 EngineData: abc ECU\n").unwrap_err();
        assert!(error.starts_with("第 2 行: "), "unexpected: {error}");
        assert!(error.contains("DLC"), "unexpected: {error}");
        assert!(error.contains("abc"), "unexpected: {error}");
    }

    #[test]
    fn reports_line_number_for_malformed_signal() {
        let error = parse(
            "bad.dbc",
            "BO_ 291 EngineData: 8 ECU\n\
             \x20SG_ Speed : 0|16@1+ [0|1] \"\" ECU\n",
        )
        .unwrap_err();
        assert!(error.starts_with("第 2 行: "), "unexpected: {error}");
        assert!(error.contains("factor"), "unexpected: {error}");
    }

    #[test]
    fn enforces_content_message_and_signal_limits() {
        let oversized = "A".repeat(MAX_CONTENT_BYTES + 1);
        assert!(parse("big.dbc", &oversized).is_err());

        let mut many_messages = String::new();
        for index in 0..=MAX_MESSAGES {
            many_messages.push_str(&format!("BO_ {index} Message{index}: 8 ECU\n"));
        }
        let error = parse("many.dbc", &many_messages).unwrap_err();
        assert!(
            error.contains(&MAX_MESSAGES.to_string()),
            "unexpected: {error}"
        );

        let mut many_signals = String::from("BO_ 291 EngineData: 8 ECU\n");
        for index in 0..=MAX_SIGNALS_PER_MESSAGE {
            many_signals.push_str(&format!(
                " SG_ Signal{index} : 0|8@1+ (1,0) [0|255] \"\" ECU\n"
            ));
        }
        let error = parse("dense.dbc", &many_signals).unwrap_err();
        assert!(
            error.contains(&MAX_SIGNALS_PER_MESSAGE.to_string()),
            "unexpected: {error}"
        );
    }

    #[test]
    fn keeps_vector_xxx_receivers_and_empty_receivers() {
        let definition = parse(
            "demo.dbc",
            "BO_ 291 EngineData: 8 ECU\n\
             \x20SG_ A : 0|8@1+ (1,0) [0|255] \"\" Vector__XXX\n\
             \x20SG_ B : 8|8@1+ (1,0) [0|255] \"\"\n",
        )
        .unwrap();
        let signals = &definition.messages[0].signals;
        assert_eq!(signals[0].receivers, vec!["Vector__XXX".to_string()]);
        assert!(signals[1].receivers.is_empty());
    }

    #[test]
    fn duplicate_signal_names_do_not_panic() {
        let definition = parse(
            "demo.dbc",
            "BO_ 291 EngineData: 8 ECU\n\
             \x20SG_ Duplicate : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
             \x20SG_ Duplicate : 8|8@1+ (1,0) [0|255] \"\" ECU\n\
             VAL_ 291 Duplicate 0 \"Off\" ;\n",
        )
        .unwrap();
        let signals = &definition.messages[0].signals;
        assert_eq!(signals.len(), 2);
        assert_eq!(signals[0].values.len(), 1);
        assert!(signals[1].values.is_empty());
    }

    #[test]
    fn reports_signal_outside_message_context() {
        let error = parse("bad.dbc", " SG_ Orphan : 0|8@1+ (1,0) [0|1] \"\" ECU\n").unwrap_err();
        assert!(error.starts_with("第 1 行: "), "unexpected: {error}");
        assert!(error.contains("BO_"), "unexpected: {error}");
    }

    #[test]
    fn load_file_reads_and_parses_from_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("demo.dbc");
        std::fs::write(
            &path,
            "BO_ 291 EngineData: 8 ECU\n\
             \x20SG_ Speed : 0|16@1+ (0.25,0) [0|16383.75] \"rpm\" CLUSTER\n",
        )
        .unwrap();
        let definition = load_file(&path).unwrap();
        assert_eq!(definition.name, "demo.dbc");
        assert_eq!(definition.messages.len(), 1);
        assert_eq!(definition.messages[0].signals[0].name, "Speed");
    }

    #[test]
    fn load_file_reports_missing_file() {
        let error = load_file(Path::new("/nonexistent/can-tools/demo.dbc")).unwrap_err();
        assert!(error.contains("无法读取 DBC 文件"), "unexpected: {error}");
    }
}
