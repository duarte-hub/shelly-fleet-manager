/**
 * Shelly Fleet Manager sidebar panel.
 *
 * Plain vanilla-JS Web Component (no build step) so HACS/HA can serve this
 * file as-is. HA sets `.hass` on this element whenever state changes; we
 * poll the backend's device list on an interval and re-render the table.
 */

const FEATURES = [
  { key: "eco_mode", label: "Eco Mode" },
  { key: "cloud", label: "Cloud" },
  { key: "mqtt", label: "MQTT" },
  { key: "ble", label: "BLE" },
  { key: "discoverable", label: "Discoverable" },
];

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index = Python weekday()

// Device-poll interval choices (seconds) offered on the Maintenance tab; 0 = manual only.
const POLL_INTERVAL_PRESETS = [0, 5, 10, 15, 30, 60, 300, 900, 3600];

// How often the panel re-reads the backend's cached snapshot. Cheap — this
// doesn't touch the devices; the backend's configurable poll interval does.
const POLL_MS = 15000;
const STATIC_BASE = "/shelly_fleet_static";

class ShellyFleetPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._devices = [];
    this._maintenance = null; // { poll_interval, time_zone, reboot_schedules }
    this._tab = "devices"; // "devices" | "maintenance"
    this._scheduleDraft = null; // reboot schedule being created/edited in the dialog
    this._refreshing = false;
    this._selected = new Set();
    this._editingName = null; // device id whose name is being edited
    this._batchFeature = FEATURES[0].key;
    this._showAddDialog = false;
    this._candidates = null; // null = not scanned yet
    this._scanning = false;
    this._addingAll = false;
    this._showBulkApply = false;
    this._busy = new Set(); // device ids with an in-flight action
    this._error = null;
    this._root = this.attachShadow({ mode: "open" });
    this._fileInput = null;
  }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first) {
      this._refresh();
      this._pollTimer = setInterval(() => this._refresh(), POLL_MS);
    }
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  async _callWS(msg) {
    return this._hass.callWS(msg);
  }

  async _refresh() {
    try {
      const [devices, maintenance] = await Promise.all([
        this._callWS({ type: "shelly_fleet/list_devices" }),
        this._callWS({ type: "shelly_fleet/get_maintenance" }),
      ]);
      this._devices = devices.devices || [];
      this._maintenance = maintenance;
    } catch (err) {
      this._error = err.message || String(err);
    }
    // Don't clobber in-progress input (rename box, open dialogs); whatever
    // closes them re-renders.
    if (this._editingName || this._scheduleDraft || this._showAddDialog || this._showBulkApply) return;
    this._render();
  }

  /** Make the backend re-poll every device now, rather than re-reading its cache. */
  async _forceRefresh() {
    this._refreshing = true;
    this._render();
    try {
      await this._callWS({ type: "shelly_fleet/refresh" });
    } catch (err) {
      this._error = `Refresh failed: ${err.message || err}`;
    }
    this._refreshing = false;
    await this._refresh();
  }

  async _setPollInterval(seconds) {
    try {
      this._maintenance = await this._callWS({ type: "shelly_fleet/set_poll_interval", seconds });
    } catch (err) {
      this._error = `Failed to set poll interval: ${err.message || err}`;
    }
    this._render();
  }

  _openScheduleDialog(schedule) {
    this._scheduleDraft = {
      name: "Maintenance reboot",
      enabled: true,
      time: "03:00",
      days: [0, 1, 2, 3, 4, 5, 6],
      device_ids: [],
      stagger_seconds: 30,
      ...schedule,
    };
    this._tab = "maintenance";
    this._render();
  }

  async _saveSchedule(schedule) {
    try {
      await this._callWS({ type: "shelly_fleet/save_reboot_schedule", schedule: scheduleFields(schedule) });
      this._scheduleDraft = null;
    } catch (err) {
      const message = `Failed to save schedule: ${err.message || err}`;
      if (this._scheduleDraft) this._scheduleDraft.error = message;
      else this._error = message;
    }
    await this._refresh();
    this._render();
  }

  async _deleteSchedule(scheduleId) {
    const schedule = this._findSchedule(scheduleId);
    if (!confirm(`Delete the schedule "${schedule ? schedule.name : scheduleId}"?`)) return;
    try {
      await this._callWS({ type: "shelly_fleet/delete_reboot_schedule", schedule_id: scheduleId });
    } catch (err) {
      this._error = `Failed to delete schedule: ${err.message || err}`;
    }
    await this._refresh();
  }

  async _runScheduleNow(scheduleId) {
    const schedule = this._findSchedule(scheduleId);
    if (!schedule) return;
    if (!confirm(`Reboot ${schedule.device_ids.length} device(s) from "${schedule.name}" now?`)) return;
    try {
      await this._callWS({ type: "shelly_fleet/run_reboot_schedule", schedule_id: scheduleId });
    } catch (err) {
      this._error = `Failed to start schedule: ${err.message || err}`;
    }
    await this._refresh();
  }

  _findSchedule(scheduleId) {
    return (this._maintenance?.reboot_schedules || []).find((s) => s.id === scheduleId);
  }

  async _setFeature(deviceId, feature, value) {
    this._busy.add(deviceId);
    this._render();
    try {
      await this._callWS({
        type: "shelly_fleet/set_feature",
        device_id: deviceId,
        feature,
        value,
      });
    } catch (err) {
      this._error = `Failed to set ${feature}: ${err.message || err}`;
    }
    this._busy.delete(deviceId);
    await this._refresh();
  }

  async _batchApply(value) {
    const ids = [...this._selected];
    if (ids.length === 0) return;
    ids.forEach((id) => this._busy.add(id));
    this._render();
    try {
      await this._callWS({
        type: "shelly_fleet/batch_set_feature",
        device_ids: ids,
        feature: this._batchFeature,
        value,
      });
    } catch (err) {
      this._error = `Batch operation failed: ${err.message || err}`;
    }
    ids.forEach((id) => this._busy.delete(id));
    await this._refresh();
  }

  async _rename(deviceId, name) {
    if (!name.trim()) return;
    this._busy.add(deviceId);
    this._render();
    try {
      await this._callWS({ type: "shelly_fleet/rename_device", device_id: deviceId, name });
    } catch (err) {
      this._error = `Rename failed: ${err.message || err}`;
    }
    this._busy.delete(deviceId);
    await this._refresh();
  }

  async _reboot(deviceId) {
    if (!confirm("Reboot this device?")) return;
    this._busy.add(deviceId);
    this._render();
    try {
      await this._callWS({ type: "shelly_fleet/reboot", device_id: deviceId });
    } catch (err) {
      this._error = `Reboot failed: ${err.message || err}`;
    }
    this._busy.delete(deviceId);
    this._render();
  }

  async _batchReboot() {
    const ids = [...this._selected];
    if (ids.length === 0) return;
    if (!confirm(`Reboot ${ids.length} device(s)?`)) return;
    ids.forEach((id) => this._busy.add(id));
    this._render();
    try {
      await this._callWS({ type: "shelly_fleet/batch_reboot", device_ids: ids });
    } catch (err) {
      this._error = `Batch reboot failed: ${err.message || err}`;
    }
    ids.forEach((id) => this._busy.delete(id));
    this._render();
  }

  async _removeDevice(deviceId) {
    if (!confirm("Remove this device from the fleet manager? (does not factory reset it)")) return;
    try {
      await this._callWS({ type: "shelly_fleet/remove_device", device_id: deviceId });
    } catch (err) {
      this._error = `Remove failed: ${err.message || err}`;
    }
    this._selected.delete(deviceId);
    await this._refresh();
  }

  async _batchRemove() {
    const ids = [...this._selected];
    if (ids.length === 0) return;
    if (!confirm(`Remove ${ids.length} device(s) from the fleet manager?`)) return;
    for (const id of ids) {
      try {
        await this._callWS({ type: "shelly_fleet/remove_device", device_id: id });
      } catch (err) {
        this._error = `Remove failed for ${id}: ${err.message || err}`;
      }
    }
    this._selected.clear();
    await this._refresh();
  }

  async _zigbeeClear(deviceId) {
    if (!confirm("Clear this device's Zigbee network state? It will forget its current pairing.")) return;
    this._busy.add(deviceId);
    this._render();
    try {
      await this._callWS({ type: "shelly_fleet/zigbee_clear", device_id: deviceId });
    } catch (err) {
      this._error = `Zigbee clear failed: ${err.message || err}`;
    }
    this._busy.delete(deviceId);
    this._render();
  }

  async _batchZigbeeClear() {
    const ids = [...this._selected];
    if (ids.length === 0) return;
    if (!confirm(`Clear the Zigbee network state on ${ids.length} device(s)?`)) return;
    ids.forEach((id) => this._busy.add(id));
    this._render();
    try {
      const result = await this._callWS({ type: "shelly_fleet/batch_zigbee_clear", device_ids: ids });
      const failed = Object.entries(result.results || {}).filter(([, r]) => !r.ok);
      if (failed.length > 0) {
        this._error = `Zigbee clear failed for ${failed.length} device(s)`;
      }
    } catch (err) {
      this._error = `Batch Zigbee clear failed: ${err.message || err}`;
    }
    ids.forEach((id) => this._busy.delete(id));
    this._render();
  }

  _exportConfig() {
    const ids = this._selected.size > 0 ? this._selected : new Set(this._devices.map((d) => d.id));
    const devices = this._devices
      .filter((d) => ids.has(d.id))
      .map((d) => ({
        id: d.id,
        ip: d.ip,
        name: d.name,
        eco_mode: d.eco_mode,
        cloud: d.cloud,
        mqtt: d.mqtt,
        ble: d.ble,
        discoverable: d.discoverable,
      }));
    const blob = new Blob([JSON.stringify({ devices }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shelly-fleet-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _triggerImport() {
    if (!this._fileInput) {
      this._fileInput = document.createElement("input");
      this._fileInput.type = "file";
      this._fileInput.accept = "application/json";
      this._fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) this._importConfigFile(file);
        this._fileInput.value = "";
      });
    }
    this._fileInput.click();
  }

  async _importConfigFile(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      this._error = `Invalid config file: ${err.message || err}`;
      this._render();
      return;
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.devices || [];
    if (entries.length === 0) {
      this._error = "Config file contained no devices.";
      this._render();
      return;
    }
    if (!confirm(`Apply imported config to ${entries.length} device(s)?`)) return;

    const errors = [];
    for (const entry of entries) {
      if (!entry.id) continue;
      const config = {};
      for (const key of ["name", ...FEATURES.map((f) => f.key)]) {
        if (key in entry) config[key] = entry[key];
      }
      try {
        await this._callWS({
          type: "shelly_fleet/apply_device_config",
          device_id: entry.id,
          config,
        });
      } catch (err) {
        errors.push(`${entry.id}: ${err.message || err}`);
      }
    }
    if (errors.length > 0) {
      this._error = `Import had ${errors.length} error(s): ${errors.join("; ")}`;
    }
    await this._refresh();
  }

  async _submitBulkApply(config) {
    const ids = [...this._selected];
    if (ids.length === 0 || Object.keys(config).length === 0) {
      this._showBulkApply = false;
      this._render();
      return;
    }
    ids.forEach((id) => this._busy.add(id));
    this._showBulkApply = false;
    this._render();
    try {
      const result = await this._callWS({
        type: "shelly_fleet/batch_apply_config",
        device_ids: ids,
        config,
      });
      const failed = Object.entries(result.results || {}).filter(([, r]) => !r.ok);
      if (failed.length > 0) {
        this._error = `Bulk apply failed for ${failed.length} device(s)`;
      }
    } catch (err) {
      this._error = `Bulk apply failed: ${err.message || err}`;
    }
    ids.forEach((id) => this._busy.delete(id));
    await this._refresh();
  }

  async _scan() {
    this._scanning = true;
    this._candidates = [];
    this._render();
    try {
      const result = await this._callWS({ type: "shelly_fleet/discover", scan_seconds: 5 });
      this._candidates = result.candidates || [];
    } catch (err) {
      this._error = `Scan failed: ${err.message || err}`;
      this._candidates = [];
    }
    this._scanning = false;
    this._render();
  }

  async _addAllCandidates() {
    const candidates = (this._candidates || []).filter((c) => c.id);
    if (candidates.length === 0) return;
    this._addingAll = true;
    this._render();
    try {
      const result = await this._callWS({
        type: "shelly_fleet/add_devices",
        devices: candidates.map((c) => ({ ip: c.ip, name: c.name })),
      });
      const failed = Object.entries(result.results || {}).filter(([, r]) => !r.ok);
      if (failed.length > 0) {
        this._error = `${failed.length} device(s) failed to add: ${failed
          .map(([ip, r]) => `${ip} (${r.error})`)
          .join(", ")}`;
      }
      this._showAddDialog = false;
      this._candidates = null;
    } catch (err) {
      this._error = `Add all failed: ${err.message || err}`;
    }
    this._addingAll = false;
    await this._refresh();
  }

  async _addDevice({ ip, name, username, password }) {
    try {
      await this._callWS({
        type: "shelly_fleet/add_device",
        ip,
        ...(name ? { name } : {}),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      });
      this._showAddDialog = false;
      this._candidates = null;
      await this._refresh();
    } catch (err) {
      this._error = `Add device failed: ${err.message || err}`;
      this._render();
    }
  }

  _toggleSelected(id, checked) {
    if (checked) this._selected.add(id);
    else this._selected.delete(id);
    this._render();
  }

  _toggleSelectAll(checked) {
    this._selected = checked ? new Set(this._devices.map((d) => d.id)) : new Set();
    this._render();
  }

  _renderFeatureCell(device, feature) {
    const value = !!device[feature.key];
    const disabled = !device.online || this._busy.has(device.id);
    return `
      <label class="switch ${disabled ? "disabled" : ""}" title="${feature.label}">
        <input type="checkbox" data-action="feature" data-id="${escapeAttr(device.id)}" data-feature="${feature.key}"
               ${value ? "checked" : ""} ${disabled ? "disabled" : ""} />
        <span class="slider"></span>
      </label>`;
  }

  _renderRssi(device) {
    if (!device.online || device.rssi == null) return `<span class="muted">-</span>`;
    const rssi = device.rssi;
    const bars = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
    const quality = ["", "Poor", "Fair", "Good", "Excellent"][bars];
    const title = `${quality} signal${device.ssid ? ` on ${device.ssid}` : ""}`;
    return `
      <span class="rssi rssi-${bars}" title="${escapeAttr(title)}">
        <span class="bars">${[1, 2, 3, 4].map((i) => `<i class="${i <= bars ? "on" : ""}"></i>`).join("")}</span>
        ${escapeHtml(rssi)} dBm
      </span>`;
  }

  _renderRow(device) {
    const busy = this._busy.has(device.id);
    const statusDot = device.online ? "online" : "offline";
    const checked = this._selected.has(device.id);
    return `
      <tr class="${busy ? "busy" : ""}">
        <td><input type="checkbox" data-action="select" data-id="${escapeAttr(device.id)}" ${checked ? "checked" : ""} /></td>
        <td><span class="dot ${statusDot}" title="${escapeAttr(device.online ? "Online" : device.error || "Offline")}"></span></td>
        <td>
          ${this._editingName === device.id
            ? `<input class="name-input" type="text" data-action="rename" data-id="${escapeAttr(device.id)}"
                      value="${escapeAttr(device.name || "")}" />`
            : `<span class="name-cell">
                 <a class="name-link" href="http://${escapeAttr(device.ip || "")}" target="_blank" rel="noopener noreferrer"
                    title="Open device web UI">${escapeHtml(device.name || device.ip || device.id)}</a>
                 <button class="name-edit" data-action="edit-name" data-id="${escapeAttr(device.id)}"
                         ${!device.online ? "disabled" : ""} title="Rename">✎</button>
               </span>`}
        </td>
        <td>${escapeHtml(device.ip || "")}</td>
        <td>${escapeHtml(device.model || "-")}</td>
        <td>${device.gen != null ? "Gen" + device.gen : "-"}</td>
        <td>${escapeHtml(device.fw_version || "-")}</td>
        <td>${this._renderRssi(device)}</td>
        ${FEATURES.map((f) => `<td>${this._renderFeatureCell(device, f)}</td>`).join("")}
        <td class="actions">
          <button data-action="reboot" data-id="${escapeAttr(device.id)}" ${!device.online ? "disabled" : ""} title="Reboot">⟳</button>
          <button data-action="zigbee-clear" data-id="${escapeAttr(device.id)}" ${!device.online ? "disabled" : ""} title="Clear Zigbee network">⎌</button>
          <button data-action="remove" data-id="${escapeAttr(device.id)}" title="Remove">✕</button>
        </td>
      </tr>`;
  }

  _renderAddDialog() {
    if (!this._showAddDialog) return "";
    const candidates = this._candidates;
    return `
      <div class="dialog-backdrop" data-action="close-dialog">
        <div class="dialog" data-stop>
          <h2>Add Shelly Device</h2>
          <div class="dialog-row">
            <button data-action="scan" ${this._scanning ? "disabled" : ""}>
              ${this._scanning ? "Scanning…" : "Scan Network"}
            </button>
            ${candidates && candidates.length > 0
              ? `<button class="primary" data-action="add-all" ${this._addingAll ? "disabled" : ""}>
                  ${this._addingAll ? "Adding…" : `Add All (${candidates.length})`}
                </button>`
              : ""}
          </div>
          ${candidates === null
            ? ""
            : candidates.length === 0 && !this._scanning
            ? `<p class="hint">No new devices found.</p>`
            : `<ul class="candidates">
                ${candidates
                  .map(
                    (c) => `
                  <li>
                    <span>${escapeHtml(c.name || c.id)} — ${escapeHtml(c.ip)} (Gen${c.gen}, ${escapeHtml(c.model || "")})</span>
                    <button data-action="quick-add" data-ip="${escapeAttr(c.ip)}" data-name="${escapeAttr(c.name || c.id || "")}">Add</button>
                  </li>`
                  )
                  .join("")}
              </ul>`}
          <hr />
          <form data-action="manual-add">
            <label>IP address <input required name="ip" type="text" placeholder="192.168.1.50" /></label>
            <label>Name (optional) <input name="name" type="text" /></label>
            <label>Username (optional) <input name="username" type="text" placeholder="admin" /></label>
            <label>Password (optional) <input name="password" type="password" /></label>
            <div class="dialog-actions">
              <button type="button" data-action="close-dialog">Cancel</button>
              <button type="submit" class="primary">Add</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  _renderBulkApplyDialog() {
    if (!this._showBulkApply) return "";
    return `
      <div class="dialog-backdrop" data-action="close-bulk-apply">
        <div class="dialog" data-stop>
          <h2>Bulk Apply (${this._selected.size} device${this._selected.size === 1 ? "" : "s"})</h2>
          <p class="hint">Leave a feature on "No change" to skip it. Applies to every selected device.</p>
          <form data-action="submit-bulk-apply">
            ${FEATURES.map(
              (f) => `
              <label class="bulk-row">
                <span>${f.label}</span>
                <select name="${f.key}">
                  <option value="">No change</option>
                  <option value="true">Enable</option>
                  <option value="false">Disable</option>
                </select>
              </label>`
            ).join("")}
            <div class="dialog-actions">
              <button type="button" data-action="close-bulk-apply">Cancel</button>
              <button type="submit" class="primary">Apply</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  _renderScheduleDialog() {
    const d = this._scheduleDraft;
    if (!d) return "";
    const deviceRows = this._devices
      .map(
        (dev) => `
        <label class="check-row">
          <input type="checkbox" name="device" value="${escapeAttr(dev.id)}" ${d.device_ids.includes(dev.id) ? "checked" : ""} />
          <span>${escapeHtml(dev.name || dev.id)}</span>
          <span class="muted">${escapeHtml(dev.ip || "")}</span>
        </label>`
      )
      .join("");
    return `
      <div class="dialog-backdrop" data-action="close-schedule">
        <div class="dialog" data-stop>
          <h2>${d.id ? "Edit" : "New"} Reboot Schedule</h2>
          <form data-action="submit-schedule">
            <label>Name <input required name="name" type="text" value="${escapeAttr(d.name)}" /></label>
            <label>Time (${escapeHtml(this._maintenance?.time_zone || "HA time zone")})
              <input required name="time" type="time" value="${escapeAttr(d.time)}" />
            </label>
            <div class="field">
              <span class="field-label">Days</span>
              <div class="days">
                ${DAYS.map(
                  (label, i) => `
                  <label class="day"><input type="checkbox" name="day" value="${i}" ${d.days.includes(i) ? "checked" : ""} />${label}</label>`
                ).join("")}
              </div>
            </div>
            <label>Delay between device reboots (seconds)
              <input required name="stagger" type="number" min="0" max="3600" value="${d.stagger_seconds}" />
            </label>
            <div class="field">
              <span class="field-label">
                Devices
                <span class="spacer"></span>
                <button type="button" class="link" data-action="schedule-select-all">All</button>
                <button type="button" class="link" data-action="schedule-select-none">None</button>
              </span>
              <div class="device-picker">
                ${deviceRows || `<p class="hint">No devices in the fleet yet.</p>`}
              </div>
            </div>
            <label class="check-row">
              <input type="checkbox" name="enabled" ${d.enabled ? "checked" : ""} /> <span>Enabled</span>
            </label>
            ${d.error ? `<p class="form-error">${escapeHtml(d.error)}</p>` : ""}
            <div class="dialog-actions">
              <button type="button" data-action="close-schedule">Cancel</button>
              <button type="submit" class="primary">Save</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  _renderMaintenanceTab() {
    const m = this._maintenance;
    if (!m) return `<div class="empty">Loading…</div>`;

    const presets = POLL_INTERVAL_PRESETS.includes(m.poll_interval)
      ? POLL_INTERVAL_PRESETS
      : [...POLL_INTERVAL_PRESETS, m.poll_interval].sort((a, b) => a - b);
    const deviceName = (id) => this._devices.find((dev) => dev.id === id)?.name || id;
    const schedules = m.reboot_schedules || [];

    const rows = schedules
      .map((s) => {
        const result = s.last_result;
        let lastRun = `<span class="muted">Never</span>`;
        if (s.running) {
          lastRun = `<span class="running">Running…</span>`;
        } else if (s.last_run) {
          const errors = Object.entries(result?.errors || {})
            .map(([id, e]) => `${deviceName(id)}: ${e}`)
            .join("\n");
          lastRun = `
            ${escapeHtml(new Date(s.last_run).toLocaleString())}
            <span class="${result?.failed ? "result-bad" : "result-ok"}" title="${escapeAttr(errors)}">
              ${result?.ok ?? 0} ok${result?.failed ? `, ${result.failed} failed` : ""}
            </span>`;
        }
        return `
          <tr>
            <td>
              <label class="switch" title="Enabled">
                <input type="checkbox" data-action="schedule-enabled" data-id="${escapeAttr(s.id)}" ${s.enabled ? "checked" : ""} />
                <span class="slider"></span>
              </label>
            </td>
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.time)} · ${escapeHtml(describeDays(s.days))}</td>
            <td title="${escapeAttr(s.device_ids.map(deviceName).join("\n"))}">${s.device_ids.length}</td>
            <td>${s.stagger_seconds ? `${s.stagger_seconds}s` : "None"}</td>
            <td>${lastRun}</td>
            <td class="actions">
              <button data-action="schedule-run" data-id="${escapeAttr(s.id)}" ${s.running ? "disabled" : ""} title="Run now">▶</button>
              <button data-action="schedule-edit" data-id="${escapeAttr(s.id)}" title="Edit">✎</button>
              <button data-action="schedule-delete" data-id="${escapeAttr(s.id)}" title="Delete">✕</button>
            </td>
          </tr>`;
      })
      .join("");

    return `
      <section class="card">
        <h2>Status polling</h2>
        <p class="hint">
          How often Home Assistant reads every device's status, settings and Wi-Fi signal.
          The Refresh button always polls all devices immediately.
        </p>
        <label class="inline">
          Poll devices
          <select data-action="poll-interval">
            ${presets
              .map((s) => `<option value="${s}" ${s === m.poll_interval ? "selected" : ""}>${describeInterval(s)}</option>`)
              .join("")}
          </select>
        </label>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Scheduled reboots</h2>
          <div class="spacer"></div>
          <button class="primary" data-action="new-schedule">+ New Schedule</button>
        </div>
        <p class="hint">
          Reboots devices one at a time, waiting the configured delay between each so the whole
          fleet doesn't drop off at once. Times use Home Assistant's time zone (${escapeHtml(m.time_zone)}).
        </p>
        ${schedules.length === 0
          ? `<div class="empty">No reboot schedules yet.</div>`
          : `
          <div class="table-wrap">
            <table class="schedules">
              <thead>
                <tr>
                  <th>Enabled</th>
                  <th>Name</th>
                  <th>When</th>
                  <th>Devices</th>
                  <th>Delay</th>
                  <th>Last run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`}
      </section>`;
  }

  _renderDevicesTab() {
    const selectedCount = this._selected.size;
    const allSelected = this._devices.length > 0 && selectedCount === this._devices.length;
    return `
        ${selectedCount > 0
          ? `
          <div class="batch-bar">
            <span>${selectedCount} selected</span>
            <select data-action="batch-feature">
              ${FEATURES.map(
                (f) => `<option value="${f.key}" ${f.key === this._batchFeature ? "selected" : ""}>${f.label}</option>`
              ).join("")}
            </select>
            <button data-action="batch-enable">Enable</button>
            <button data-action="batch-disable">Disable</button>
            <button data-action="open-bulk-apply">Bulk Apply…</button>
            <button data-action="batch-reboot">Reboot</button>
            <button data-action="batch-zigbee-clear">Clear Zigbee</button>
            <button data-action="batch-schedule-reboot">Schedule Reboot…</button>
            <button class="danger" data-action="batch-remove">Remove</button>
          </div>`
          : ""}

        ${this._devices.length === 0
          ? `<div class="empty">No devices yet. Click "Add Device" to add one by IP or scan your network.</div>`
          : `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" data-action="select-all" ${allSelected ? "checked" : ""} /></th>
                  <th></th>
                  <th>Name</th>
                  <th>IP</th>
                  <th>Model</th>
                  <th>Gen</th>
                  <th>Firmware</th>
                  <th>Wi-Fi</th>
                  ${FEATURES.map((f) => `<th>${f.label}</th>`).join("")}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${this._devices.map((d) => this._renderRow(d)).join("")}
              </tbody>
            </table>
          </div>`}`;
  }

  _render() {
    const onDevices = this._tab === "devices";
    this._root.innerHTML = `
      <style>${STYLE}</style>
      <div class="panel">
        <div class="header">
          <img class="logo" src="${STATIC_BASE}/logo.svg" alt="" />
          <h1>Shelly Fleet</h1>
          <div class="spacer"></div>
          ${onDevices
            ? `<button data-action="export">Export Config</button>
               <button data-action="import">Import Config</button>`
            : ""}
          <button data-action="refresh" ${this._refreshing ? "disabled" : ""}>
            ${this._refreshing ? "Refreshing…" : "Refresh"}
          </button>
          ${onDevices ? `<button class="primary" data-action="open-dialog">+ Add Device</button>` : ""}
        </div>

        <div class="tabs">
          <button class="tab ${onDevices ? "active" : ""}" data-action="tab" data-tab="devices">Devices</button>
          <button class="tab ${!onDevices ? "active" : ""}" data-action="tab" data-tab="maintenance">Maintenance</button>
        </div>

        ${this._error ? `<div class="error-banner">${escapeHtml(this._error)} <button data-action="dismiss-error">✕</button></div>` : ""}

        ${onDevices ? this._renderDevicesTab() : this._renderMaintenanceTab()}
      </div>
      ${this._renderAddDialog()}
      ${this._renderBulkApplyDialog()}
      ${this._renderScheduleDialog()}
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const root = this._root;

    root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => this._forceRefresh());
    root.querySelectorAll('[data-action="tab"]').forEach((el) =>
      el.addEventListener("click", () => {
        this._tab = el.dataset.tab;
        this._render();
      })
    );
    root.querySelector('[data-action="export"]')?.addEventListener("click", () => this._exportConfig());
    root.querySelector('[data-action="import"]')?.addEventListener("click", () => this._triggerImport());
    root.querySelector('[data-action="open-dialog"]')?.addEventListener("click", () => {
      this._showAddDialog = true;
      this._candidates = null;
      this._render();
    });
    root.querySelector('[data-action="dismiss-error"]')?.addEventListener("click", () => {
      this._error = null;
      this._render();
    });

    root.querySelectorAll('[data-action="close-dialog"]').forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target === el) {
          this._showAddDialog = false;
          this._render();
        }
      })
    );
    root.querySelectorAll(".dialog").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));

    root.querySelector('[data-action="scan"]')?.addEventListener("click", () => this._scan());
    root.querySelector('[data-action="add-all"]')?.addEventListener("click", () => this._addAllCandidates());

    root.querySelector('[data-action="manual-add"]')?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      this._addDevice({
        ip: form.get("ip"),
        name: form.get("name"),
        username: form.get("username"),
        password: form.get("password"),
      });
    });

    root.querySelectorAll('[data-action="quick-add"]').forEach((el) =>
      el.addEventListener("click", () =>
        this._addDevice({ ip: el.dataset.ip, name: el.dataset.name })
      )
    );

    root.querySelector('[data-action="select-all"]')?.addEventListener("change", (e) =>
      this._toggleSelectAll(e.target.checked)
    );
    root.querySelectorAll('[data-action="select"]').forEach((el) =>
      el.addEventListener("change", (e) => this._toggleSelected(el.dataset.id, e.target.checked))
    );

    root.querySelectorAll('[data-action="feature"]').forEach((el) =>
      el.addEventListener("change", (e) =>
        this._setFeature(el.dataset.id, el.dataset.feature, e.target.checked)
      )
    );

    root.querySelectorAll('[data-action="edit-name"]').forEach((el) =>
      el.addEventListener("click", () => {
        this._editingName = el.dataset.id;
        this._render();
      })
    );

    root.querySelectorAll('[data-action="rename"]').forEach((el) => {
      let cancelled = false;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") el.blur();
        if (e.key === "Escape") {
          cancelled = true;
          el.blur();
        }
      });
      el.addEventListener("blur", (e) => {
        if (!el.isConnected) return; // removed by a re-render, not a real blur
        this._editingName = null;
        const device = this._devices.find((d) => d.id === el.dataset.id);
        if (!cancelled && device && e.target.value !== device.name) {
          this._rename(el.dataset.id, e.target.value);
        } else {
          this._render();
        }
      });
      el.focus();
      el.select();
    });

    root.querySelectorAll('[data-action="reboot"]').forEach((el) =>
      el.addEventListener("click", () => this._reboot(el.dataset.id))
    );
    root.querySelectorAll('[data-action="zigbee-clear"]').forEach((el) =>
      el.addEventListener("click", () => this._zigbeeClear(el.dataset.id))
    );
    root.querySelectorAll('[data-action="remove"]').forEach((el) =>
      el.addEventListener("click", () => this._removeDevice(el.dataset.id))
    );

    root.querySelector('[data-action="batch-feature"]')?.addEventListener("change", (e) => {
      this._batchFeature = e.target.value;
    });
    root.querySelector('[data-action="batch-enable"]')?.addEventListener("click", () => this._batchApply(true));
    root.querySelector('[data-action="batch-disable"]')?.addEventListener("click", () => this._batchApply(false));
    root.querySelector('[data-action="batch-reboot"]')?.addEventListener("click", () => this._batchReboot());
    root.querySelector('[data-action="batch-zigbee-clear"]')?.addEventListener("click", () => this._batchZigbeeClear());
    root.querySelector('[data-action="batch-remove"]')?.addEventListener("click", () => this._batchRemove());
    root.querySelector('[data-action="batch-schedule-reboot"]')?.addEventListener("click", () =>
      this._openScheduleDialog({ device_ids: [...this._selected] })
    );

    // --- Maintenance tab ---
    root.querySelector('[data-action="poll-interval"]')?.addEventListener("change", (e) =>
      this._setPollInterval(Number(e.target.value))
    );
    root.querySelector('[data-action="new-schedule"]')?.addEventListener("click", () =>
      this._openScheduleDialog({})
    );
    root.querySelectorAll('[data-action="schedule-edit"]').forEach((el) =>
      el.addEventListener("click", () => {
        const schedule = this._findSchedule(el.dataset.id);
        if (schedule) this._openScheduleDialog(scheduleFields(schedule));
      })
    );
    root.querySelectorAll('[data-action="schedule-enabled"]').forEach((el) =>
      el.addEventListener("change", (e) => {
        const schedule = this._findSchedule(el.dataset.id);
        if (schedule) this._saveSchedule({ ...schedule, enabled: e.target.checked });
      })
    );
    root.querySelectorAll('[data-action="schedule-run"]').forEach((el) =>
      el.addEventListener("click", () => this._runScheduleNow(el.dataset.id))
    );
    root.querySelectorAll('[data-action="schedule-delete"]').forEach((el) =>
      el.addEventListener("click", () => this._deleteSchedule(el.dataset.id))
    );

    root.querySelectorAll('[data-action="close-schedule"]').forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target === el) {
          this._scheduleDraft = null;
          this._render();
        }
      })
    );
    const pickAll = (checked) =>
      root.querySelectorAll('.device-picker input[name="device"]').forEach((cb) => (cb.checked = checked));
    root.querySelector('[data-action="schedule-select-all"]')?.addEventListener("click", () => pickAll(true));
    root.querySelector('[data-action="schedule-select-none"]')?.addEventListener("click", () => pickAll(false));
    root.querySelector('[data-action="submit-schedule"]')?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const draft = {
        ...this._scheduleDraft,
        name: form.get("name").trim(),
        time: form.get("time"),
        days: form.getAll("day").map(Number),
        device_ids: form.getAll("device"),
        stagger_seconds: Number(form.get("stagger")) || 0,
        enabled: form.get("enabled") === "on",
        error: null,
      };
      if (draft.days.length === 0) draft.error = "Pick at least one day.";
      else if (draft.device_ids.length === 0) draft.error = "Pick at least one device.";
      this._scheduleDraft = draft;
      if (draft.error) this._render();
      else this._saveSchedule(draft);
    });

    root.querySelector('[data-action="open-bulk-apply"]')?.addEventListener("click", () => {
      this._showBulkApply = true;
      this._render();
    });
    root.querySelectorAll('[data-action="close-bulk-apply"]').forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target === el) {
          this._showBulkApply = false;
          this._render();
        }
      })
    );
    root.querySelector('[data-action="submit-bulk-apply"]')?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const config = {};
      for (const f of FEATURES) {
        const value = form.get(f.key);
        if (value === "true") config[f.key] = true;
        else if (value === "false") config[f.key] = false;
      }
      this._submitBulkApply(config);
    });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function escapeAttr(str) {
  return escapeHtml(str);
}

/** Just the fields the backend's schedule schema accepts (drops last_run etc.). */
function scheduleFields(s) {
  const { id, name, enabled, time, days, device_ids, stagger_seconds } = s;
  return { ...(id ? { id } : {}), name, enabled, time, days, device_ids, stagger_seconds };
}

function describeDays(days) {
  const key = [...days].sort((a, b) => a - b).join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "0,1,2,3,4") return "Weekdays";
  if (key === "5,6") return "Weekends";
  return key.split(",").map((d) => DAYS[d]).join(", ");
}

function describeInterval(seconds) {
  if (seconds === 0) return "Manual only (Refresh button)";
  if (seconds < 60) return `Every ${seconds} seconds`;
  if (seconds < 3600) return `Every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `Every ${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
}

const STYLE = `
  :host {
    display: block;
    height: 100%;
    background: var(--primary-background-color, #fafafa);
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    box-sizing: border-box;
  }
  * { box-sizing: border-box; }
  .panel { padding: 16px 24px 48px; max-width: 1400px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .header h1 { font-size: 24px; font-weight: 400; margin: 0; }
  .header .logo { width: 28px; height: 28px; }
  .spacer { flex: 1; }
  button {
    font: inherit;
    padding: 8px 14px;
    border-radius: 4px;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--secondary-background-color, #f0f0f0); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary {
    background: var(--primary-color, #03a9f4);
    border-color: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
  }
  button.danger { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }

  .error-banner {
    background: var(--error-color, #db4437);
    color: var(--text-primary-color, #fff);
    padding: 8px 16px;
    border-radius: 4px;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .error-banner button { background: transparent; border: none; color: inherit; font-size: 16px; }

  .batch-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 12px;
  }
  .batch-bar select { font: inherit; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--divider-color, #e0e0e0); }

  .empty {
    padding: 48px 24px;
    text-align: center;
    color: var(--secondary-text-color, #727272);
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    background: var(--card-background-color, #fff);
  }
  table { border-collapse: collapse; width: 100%; min-width: 900px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--divider-color, #e0e0e0); white-space: nowrap; }
  th { font-weight: 500; color: var(--secondary-text-color, #727272); font-size: 13px; }
  tr.busy { opacity: 0.5; }

  .name-input {
    font: inherit;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    width: 160px;
  }
  .name-cell { display: inline-flex; align-items: center; gap: 4px; }
  .name-link {
    color: var(--primary-color, #03a9f4);
    text-decoration: none;
    padding: 6px 0;
  }
  .name-link:hover { text-decoration: underline; }
  .name-edit {
    border: none;
    background: transparent;
    color: var(--secondary-text-color, #727272);
    cursor: pointer;
    padding: 2px 4px;
    opacity: 0;
  }
  tr:hover .name-edit, .name-edit:focus { opacity: 1; }
  .name-edit:disabled { visibility: hidden; }
  .name-input:hover, .name-input:focus {
    border-color: var(--divider-color, #e0e0e0);
    background: var(--secondary-background-color, #f5f5f5);
    outline: none;
  }

  .muted { color: var(--secondary-text-color, #727272); }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--divider-color, #e0e0e0); margin-bottom: 16px; }
  .tabs .tab {
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--secondary-text-color, #727272);
    padding: 10px 16px;
  }
  .tabs .tab.active { color: var(--primary-color, #03a9f4); border-bottom-color: var(--primary-color, #03a9f4); }

  .card {
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 18px; font-weight: 400; margin: 0 0 4px; }
  .card-header { display: flex; align-items: center; gap: 12px; }
  .card .table-wrap { margin-top: 8px; }
  .card .empty { padding: 24px; }
  label.inline { display: inline-flex; align-items: center; gap: 10px; }
  label.inline select { font: inherit; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--divider-color, #e0e0e0); background: var(--primary-background-color, #fff); color: inherit; }
  table.schedules { min-width: 700px; }
  .running { color: var(--primary-color, #03a9f4); }
  .result-ok { color: #4caf50; margin-left: 6px; }
  .result-bad { color: var(--error-color, #db4437); margin-left: 6px; cursor: help; }

  .rssi { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
  .rssi .bars { display: inline-flex; align-items: flex-end; gap: 1px; height: 13px; }
  .rssi .bars i { display: block; width: 3px; background: var(--divider-color, #e0e0e0); border-radius: 1px; }
  .rssi .bars i:nth-child(1) { height: 4px; }
  .rssi .bars i:nth-child(2) { height: 7px; }
  .rssi .bars i:nth-child(3) { height: 10px; }
  .rssi .bars i:nth-child(4) { height: 13px; }
  .rssi-1 .bars i.on { background: var(--error-color, #db4437); }
  .rssi-2 .bars i.on { background: #ff9800; }
  .rssi-3 .bars i.on, .rssi-4 .bars i.on { background: #4caf50; }

  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .dot.online { background: #4caf50; }
  .dot.offline { background: var(--error-color, #db4437); }

  .actions { display: flex; gap: 6px; }
  .actions button { padding: 4px 8px; }

  .switch { position: relative; display: inline-block; width: 36px; height: 20px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .slider {
    position: absolute; cursor: pointer; inset: 0;
    background-color: var(--disabled-color, #ccc);
    border-radius: 20px;
    transition: 0.15s;
  }
  .switch .slider::before {
    content: ""; position: absolute; height: 14px; width: 14px; left: 3px; bottom: 3px;
    background-color: white; border-radius: 50%; transition: 0.15s;
  }
  .switch input:checked + .slider { background-color: var(--primary-color, #03a9f4); }
  .switch input:checked + .slider::before { transform: translateX(16px); }
  .switch.disabled { opacity: 0.4; }

  .dialog-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .dialog {
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    border-radius: 8px;
    padding: 20px 24px;
    width: 420px;
    max-width: 90vw;
    max-height: 85vh;
    overflow-y: auto;
  }
  .dialog h2 { margin-top: 0; font-weight: 400; }
  .dialog-row { margin-bottom: 12px; }
  .dialog form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  .dialog label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--secondary-text-color, #727272); }
  .dialog input { font: inherit; padding: 8px; border-radius: 4px; border: 1px solid var(--divider-color, #e0e0e0); background: var(--primary-background-color, #fff); color: inherit; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .hint { color: var(--secondary-text-color, #727272); font-size: 13px; }
  .dialog label.bulk-row { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
  .bulk-row span { color: var(--primary-text-color, #212121); font-size: 14px; }
  .bulk-row select { font: inherit; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--divider-color, #e0e0e0); background: var(--primary-background-color, #fff); color: inherit; }
  .dialog .field { display: flex; flex-direction: column; gap: 4px; }
  .dialog .field-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text-color, #727272); }
  .dialog .days { display: flex; flex-wrap: wrap; gap: 6px; }
  .dialog label.day, .dialog label.check-row {
    flex-direction: row; align-items: center; gap: 6px; font-size: 14px; color: var(--primary-text-color, #212121);
  }
  .dialog label.day { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 4px; padding: 4px 8px; }
  .dialog label.check-row .muted { margin-left: auto; font-size: 12px; }
  .dialog input[type="checkbox"] { padding: 0; }
  .device-picker {
    max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 4px; padding: 8px;
  }
  button.link { border: none; background: transparent; color: var(--primary-color, #03a9f4); padding: 0 4px; font-size: 13px; }
  .form-error { color: var(--error-color, #db4437); font-size: 13px; margin: 0; }
  ul.candidates { list-style: none; padding: 0; margin: 0 0 12px; max-height: 180px; overflow-y: auto; }
  ul.candidates li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--divider-color, #eee); }
`;

customElements.define("shelly-fleet-panel", ShellyFleetPanel);
