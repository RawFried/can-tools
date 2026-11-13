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
    "recorded_frames": 1234,
    "tx_frames": 12
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
  `acc_mask = 0xFFFFFFFF` accept every frame. The web UI exposes **ID ranges only**: it derives a
  hardware filter that is a *superset* of the ranges (the smallest power-of-two aligned block
  covering them) so the controller can pre-drop frames, and sends the exact ranges as
  `software_filters` for precise matching. An empty range list, or ranges mixing standard and
  extended frames, falls back to accept-all. Range semantics therefore live in `software_filters`;
  clients that need an exact hardware filter still set `filter` directly.
- `software_filters` are applied by the application after the hardware filter. An empty list
  accepts every frame. Otherwise a frame passes when at least one record matches both its
  standard/extended flag and `start <= id <= end`.
- `stats.rx_rate` is the accepted-frame rate over the last second (frames/second).
- `stats.tx_frames` is the number of frames successfully sent since the device was opened or
  the live counters were cleared.

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

## DBC definition object

A parsed DBC file is exposed as one definition. All fields are always present.

```json
{
  "name": "demo.dbc",
  "loaded_at_ms": 1762681234567,
  "messages": [
    {
      "id": 291,
      "extended": false,
      "name": "EngineData",
      "dlc": 8,
      "sender": "ECU",
      "signals": [
        {
          "name": "EngineSpeed",
          "start_bit": 0,
          "length": 16,
          "little_endian": true,
          "signed": false,
          "factor": 0.25,
          "offset": 0.0,
          "min": 0.0,
          "max": 16383.75,
          "unit": "rpm",
          "receivers": ["CLUSTER"],
          "value_kind": "unsigned",
          "mux": null,
          "values": [
            {"raw": 0, "label": "Off"},
            {"raw": 1, "label": "On"}
          ]
        }
      ]
    }
  ]
}
```

- `id` never includes the frame-type flag: standard IDs are `0..=0x7FF`, extended IDs are
  `0..=0x1FFFFFFF`; `extended` comes from bit 31 of the DBC `BO_` raw ID.
- `dlc` is clamped to `0..=8` (larger values are stored as 8).
- `value_kind` is `unsigned`, `signed`, `float` or `double`. The `SG_` sign selects signedness;
  `SIG_VALTYPE_ <id> <signal> : 1` forces `float` and `: 2` forces `double` (both clear `signed`).
- `mux` is `null` for a normal signal, `{"is_multiplexer": true, "value": null}` for `M`, and
  `{"is_multiplexer": false, "value": 3}` for `m3`. `m<N>M` is reported with
  `is_multiplexer: true` and `value: N`.
- `values` is the `VAL_` table (`[]` when absent); `raw` is a signed 64-bit integer.
- `receivers` keeps every receiver name verbatim, including `Vector__XXX`; it is `[]` when the
  signal declares no receiver.
- Unrelated DBC sections (`VERSION`, `NS_`, `BS_`, `BU_`, `CM_`, `BA_DEF_`, `BA_`, `VAL_TABLE_`,
  `SGTYPE_`, `EV_`, …) are ignored. Lines starting with `//` are comments.
- Limits: content ≤ 1 MiB, ≤ 5000 messages, ≤ 512 signals per message. Parse failures are
  reported with a 1-based line number and a Chinese message.

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

### `POST /api/filters`

Updates filtering on **already running** channels without closing/reopening the device:

```json
{
  "channels": [0, 1],
  "filter": {"acc_code": 0, "acc_mask": 4294967295, "mode": 0},
  "software_filters": [{"extended": false, "start": 256, "end": 511}]
}
```

- `software_filters` take effect immediately in the host worker.
- If the hardware filter changed for a running channel, the worker re-runs `InitCAN` +
  `StartCAN` without `ResetCAN`/close; this is a fast hot re-initialization, not a channel stop.
- If only software filters changed, no USB I/O is performed.
- Every selected channel must be running; otherwise the request fails with a clear error.
- The request also accepts listen-only channels (they still receive/filter).

Response: `{"ok": true, "status": { ... }}`

### `POST /api/stop`

Stops (resets) the given channels. An omitted `channels` field stops all running channels.

```json
{"channels": [0, 1]}
```

Response: `{"ok": true, "status": { ... }}`

### `POST /api/send`

Sends one CAN frame on a running channel. The device must be open and the target channel
started (for example with `mode: "self_test"` to see the frame loop back into the receiver).
Listen-only channels reject sends.

```json
{
  "channel": 0,
  "id": 291,
  "extended": false,
  "remote": false,
  "dlc": 8,
  "data": "11 22 33 44 55 66 77 88"
}
```

- `id` is validated against 0x7FF (standard) or 0x1FFFFFFF (extended).
- `data` accepts spaced bytes (`"11 22 33"`), a contiguous string (`"112233"`) or tokens with
  `0x` prefixes; at most 8 bytes.
- `dlc` is optional. For data frames it must equal the byte count; for remote frames it may be
  0–8 and `data` must be empty.
- Recording captures received frames; a frame sent in normal mode is not echoed unless the
  bus/device loops it back.

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

### `POST /api/dbc`

Uploads and parses a DBC file. The body carries the raw text:

```json
{"name": "demo.dbc", "content": "VERSION \"\"\n...\n"}
```

- `content` must not exceed 1 MiB.
- On success the definition replaces the previous one, is persisted under
  `<data_dir>/dbc/<safe-name>.dbc`, and a `dbc` WebSocket event is broadcast.
- The safe name keeps only `[A-Za-z0-9._-]`, must end in `.dbc`, may not contain path
  separators, and is at most 96 characters. Only one `.dbc` is kept in that directory.
- Response: `{"ok": true, "dbc": { ... }}`
- Parse or validation failure: `400` with `{"ok": false, "error": "第 12 行: ..."}`.

### `GET /api/dbc`

Returns the currently loaded definition, or `null` when none is loaded:

```json
{"dbc": { ... }}
```

```json
{"dbc": null}
```

### `DELETE /api/dbc`

Removes the loaded definition and deletes the persisted `.dbc` file. Succeeds even when nothing
is loaded. Response: `{"ok": true}`

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
{"type": "snapshot", "status": { ... }, "frames": [ ... ], "dbc": { ... }}
```

`dbc` is the full definition or `null`. Event variants:

```json
{"type": "frames", "frames": [ ... ]}
{"type": "status", "status": { ... }}
{"type": "log", "level": "info", "message": "已启动 CAN1 (500k)"}
{"type": "cleared"}
{"type": "dbc", "dbc": { ... }}
```

A `dbc` event is broadcast after `POST /api/dbc` and `DELETE /api/dbc` (`dbc: null` for the
latter). The `status` object is unchanged and does not contain DBC state. Status is also pushed
at least once per second while frames flow. Clients should reconnect with backoff when the
socket closes.
