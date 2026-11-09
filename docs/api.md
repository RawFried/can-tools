# CAN Tools HTTP / WebSocket API

All endpoints are served from the same origin as the web UI. Request and response bodies are
UTF-8 JSON unless noted otherwise. Failures use the HTTP status code plus:

```json
{"ok": false, "error": "人类可读的错误说明"}
```

Hex values in JSON are plain unsigned integers (not strings). The UI is responsible for parsing
`0x...` input and rendering values as hex.

## Status object

```json
{
  "device": {
    "open": true,
    "info": {
      "index": 0,
      "fw_version": "3.51",
      "serial": "000000000001",
      "hw_type": "CAN-Linux",
      "channel_count": 2
    }
  },
  "channels": [
    {
      "index": 0,
      "running": true,
      "baud": "500k",
      "mode": "normal",
      "filter": {"acc_code": 0, "acc_mask": 4294967295, "mode": 1}
    },
    {"index": 1, "running": false, "baud": null, "mode": null, "filter": null}
  ],
  "software_filters": [{"extended": false, "start": 256, "end": 511}],
  "recording": {
    "active": true,
    "file": "can-20261109-150000.csv",
    "frames": 1234,
    "started_at_ms": 1762681200000
  },
  "stats": {
    "rx_frames": 1234,
    "filtered_frames": 3,
    "rx_rate": 420.5,
    "recorded_frames": 1234
  },
  "server": {
    "version": "0.1.0",
    "data_dir": "/home/user/.local/share/can-tools"
  }
}
```

- `baud` is one of `5k`, `10k`, `20k`, `50k`, `100k`, `125k`, `250k`, `500k`, `800k`, `1000k`.
- `mode` is one of `normal`, `listen_only`, `self_test`.
- `filter.mode` is `0` (accept all), `1` (single filter) or `2` (dual filter). The
  controller compares a normalized 32-bit value, not the raw CAN ID: standard frames use
  `acc_code = id << 21` with `acc_mask = 0x001FFFFF`; extended frames use
  `acc_code = id << 3` with `acc_mask = 0x00000007`. A frame passes when
  `(normalized & !acc_mask) == (acc_code & !acc_mask)`. `acc_code = 0` and
  `acc_mask = 0xFFFFFFFF` accept every frame. The web UI's "按 ID 生成" helper performs
  this conversion; ranges/multiple IDs belong in `software_filters`.
- `software_filters` are applied by the application after the hardware filter. An empty list
  accepts every frame. Otherwise a frame passes when at least one record matches both its
  standard/extended flag and `start <= id <= end`.
- `stats.rx_rate` is the accepted-frame rate over the last second (frames/second).

## Frame object

```json
{
  "seq": 17,
  "time_ms": 1762681234567,
  "device_ts": 12345,
  "channel": 0,
  "id": 291,
  "extended": false,
  "remote": false,
  "dlc": 8,
  "data": "11 22 33 44 55 66 77 88"
}
```

`time_ms` is the host receive time in UNIX milliseconds. `device_ts` is the raw 32-bit counter
reported by the device. `data` is uppercase hex separated by single spaces (empty string when
`dlc` is 0).

## REST

### `GET /api/health`

```json
{"status": "ok", "version": "0.1.0"}
```

### `GET /api/devices`

Enumerates matching USB devices (04d8:0053). Only valid while the device is closed; while open,
the current device is returned.

```json
{"devices": [{"index": 0, "fw_version": "3.51", "serial": "000000000001",
              "hw_type": "CAN-Linux", "channel_count": 2}]}
```

### `GET /api/status`

Returns the status object above.

### `POST /api/device/open`

```json
{"index": 0}
```

Response: `{"ok": true, "status": { ... }}`

The request may take a few seconds while the device re-enumerates after a recent close.

### `POST /api/device/close`

No body. Closes the device, stops recording (flushing the CSV), and resets channel state.
Response: `{"ok": true, "status": { ... }}`

### `POST /api/config`

Initializes and starts the selected channels with the given baud rate, mode and hardware
filter, then installs the software filters. Re-applying while running restarts the selected
channels. At least one channel is required.

```json
{
  "channels": [0, 1],
  "baud": "500k",
  "mode": "normal",
  "filter": {"acc_code": 0, "acc_mask": 4294967295, "mode": 1},
  "software_filters": [{"extended": false, "start": 256, "end": 511}]
}
```

Response: `{"ok": true, "status": { ... }}`

### `POST /api/stop`

Stops (resets) the given channels. An omitted `channels` field stops all running channels.

```json
{"channels": [0, 1]}
```

Response: `{"ok": true, "status": { ... }}`

### `POST /api/recording/start`

No body. Starts a new CSV recording under `server.data_dir/recordings`.

Response: `{"ok": true, "file": "can-20261109-150000.csv", "status": { ... }}`

An error is returned when recording is already active.

### `POST /api/recording/stop`

No body. Flushes and closes the current recording.

Response: `{"ok": true, "file": "can-20261109-150000.csv", "frames": 1234, "status": { ... }}`

### `POST /api/frames/clear`

Clears the in-memory live frame buffer and counter display (recorded files are untouched).
Response: `{"ok": true}`

### `GET /api/recordings`

```json
{"recordings": [{"name": "can-20261109-150000.csv", "size": 12345, "modified_ms": 1762681250000}]}
```

### `GET /api/recordings/{name}`

Downloads one CSV recording with `Content-Type: text/csv` and an attachment filename.
`{name}` must be a plain file name ending in `.csv`.

### `DELETE /api/recordings/{name}`

Deletes a recording. Response: `{"ok": true}`

## WebSocket `/ws`

On connect the server sends one snapshot message, then streams events. The client may send
`ping` text frames; they are ignored, and the connection is closed by the client or server.

Snapshot:

```json
{"type": "snapshot", "status": { ... }, "frames": [ ... ]}
```

Event variants:

```json
{"type": "frames", "frames": [ ... ]}
{"type": "status", "status": { ... }}
{"type": "log", "level": "info", "message": "已启动 CAN1 (500k)"}
{"type": "cleared"}
```

Status is also pushed at least once per second while frames flow. Clients should reconnect
with backoff when the socket closes.
