# Shelly Fleet Manager

A Home Assistant custom integration (installable via [HACS](https://hacs.xyz))
that adds fleet-wide management for Shelly Gen2/3/4 devices: a single sidebar
page listing every device with inline-editable settings and one-click batch
enable/disable across your whole fleet — the things HA's built-in `shelly`
integration doesn't give you.

Inspired by [Shelly-Manager](https://github.com/Supporterino/Shelly-Manager)
(a standalone desktop/mobile app), reimplemented as an HA-native panel that
sits alongside — not instead of — HA's core Shelly integration.

## Why this exists alongside core HA's Shelly integration

HA's built-in `shelly` integration already gives you switch/light/cover/sensor
entities for control and automation. This addon does **not** duplicate that.
Instead it talks directly to each device's JSON-RPC API for the device-level
settings core HA doesn't expose as entities: eco mode, cloud connectivity,
MQTT, BLE, mDNS discoverability, naming, reboot, and (in later phases)
firmware fleet updates and schedules — all editable in bulk from one table.

## Current status: Phase 1

- [x] Add devices by IP, or discover them via mDNS network scan
- [x] Single-page table: one row per device, live status polling
- [x] Inline-editable device name (just type in the Name column)
- [x] Per-row toggles for Eco Mode / Cloud / MQTT / BLE / Discoverable
- [x] Multi-select rows + batch toolbar: enable/disable a feature, reboot, or
      remove across every selected device at once
- [x] HA services (`shelly_fleet.set_feature`, `.batch_set_feature`,
      `.reboot`) so automations/scripts can drive the same actions
- [ ] Phase 2: firmware fleet view + one-click OTA updates across devices
- [ ] Phase 3: schedules (list/create/delete) per device

## Requirements

- Home Assistant 2024.8 or newer
- Shelly Gen2, Gen3, or Gen4 devices (JSON-RPC 2.0) on the local network
  reachable from HA

## Installation

### Via HACS (custom repository, until listed in the default HACS store)

1. HACS → the "⋮" menu (top right) → **Custom repositories**
2. Repository: this repo's GitHub URL, Category: **Integration**
3. Install "Shelly Fleet Manager", then restart Home Assistant
4. Settings → Devices & Services → **Add Integration** → search "Shelly Fleet
   Manager"
5. A **Shelly Fleet** entry appears in the sidebar (admin users only)

### Manual

Copy `custom_components/shelly_fleet` into your HA `config/custom_components/`
directory, restart HA, then follow steps 4–5 above.

## Adding devices

Open the **Shelly Fleet** panel → **Add Device** → either click **Scan
Network** (mDNS discovery) and add a found device with one click, or enter its
IP address manually. If the device has local login enabled, supply the
username/password — otherwise leave them blank.

## Security notes

- All device communication is local-only (LAN JSON-RPC), no cloud.
- Device credentials you enter are stored in HA's local storage
  (`.storage/shelly_fleet_devices`), like any other integration's config.
- The panel and every mutating action require an HA **admin** account.

## Development

No frontend build step: `www/shelly-fleet-panel.js` is a dependency-free
vanilla Web Component served as-is. Edit it and reload the page (hard refresh
to bypass cache) to see changes — no bundler required.

Backend is plain HA custom-component Python under `custom_components/shelly_fleet/`.

## License

MIT — see `LICENSE`.
