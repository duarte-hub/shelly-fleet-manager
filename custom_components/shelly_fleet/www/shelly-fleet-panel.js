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

const POLL_MS = 15000;

class ShellyFleetPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._devices = [];
    this._selected = new Set();
    this._batchFeature = FEATURES[0].key;
    this._showAddDialog = false;
    this._candidates = null; // null = not scanned yet
    this._scanning = false;
    this._busy = new Set(); // device ids with an in-flight action
    this._error = null;
    this._root = this.attachShadow({ mode: "open" });
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
      const result = await this._callWS({ type: "shelly_fleet/list_devices" });
      this._devices = result.devices || [];
      this._error = null;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._render();
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

  _renderRow(device) {
    const busy = this._busy.has(device.id);
    const statusDot = device.online ? "online" : "offline";
    const checked = this._selected.has(device.id);
    return `
      <tr class="${busy ? "busy" : ""}">
        <td><input type="checkbox" data-action="select" data-id="${escapeAttr(device.id)}" ${checked ? "checked" : ""} /></td>
        <td><span class="dot ${statusDot}" title="${escapeAttr(device.online ? "Online" : device.error || "Offline")}"></span></td>
        <td>
          <input class="name-input" type="text" data-action="rename" data-id="${escapeAttr(device.id)}"
                 value="${escapeAttr(device.name || "")}" ${!device.online ? "disabled" : ""} />
        </td>
        <td>${escapeHtml(device.ip || "")}</td>
        <td>${escapeHtml(device.model || "-")}</td>
        <td>${device.gen != null ? "Gen" + device.gen : "-"}</td>
        <td>${escapeHtml(device.fw_version || "-")}</td>
        ${FEATURES.map((f) => `<td>${this._renderFeatureCell(device, f)}</td>`).join("")}
        <td class="actions">
          <button data-action="reboot" data-id="${escapeAttr(device.id)}" ${!device.online ? "disabled" : ""} title="Reboot">⟳</button>
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

  _render() {
    const selectedCount = this._selected.size;
    const allSelected = this._devices.length > 0 && selectedCount === this._devices.length;

    this._root.innerHTML = `
      <style>${STYLE}</style>
      <div class="panel">
        <div class="header">
          <h1>Shelly Fleet</h1>
          <div class="spacer"></div>
          <button data-action="refresh">Refresh</button>
          <button class="primary" data-action="open-dialog">+ Add Device</button>
        </div>

        ${this._error ? `<div class="error-banner">${escapeHtml(this._error)} <button data-action="dismiss-error">✕</button></div>` : ""}

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
            <button data-action="batch-reboot">Reboot</button>
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
                  ${FEATURES.map((f) => `<th>${f.label}</th>`).join("")}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${this._devices.map((d) => this._renderRow(d)).join("")}
              </tbody>
            </table>
          </div>`}
      </div>
      ${this._renderAddDialog()}
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const root = this._root;

    root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => this._refresh());
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
    root.querySelector(".dialog")?.addEventListener("click", (e) => e.stopPropagation());

    root.querySelector('[data-action="scan"]')?.addEventListener("click", () => this._scan());

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

    root.querySelectorAll('[data-action="rename"]').forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") el.blur();
      });
      el.addEventListener("blur", (e) => {
        const device = this._devices.find((d) => d.id === el.dataset.id);
        if (device && e.target.value !== device.name) {
          this._rename(el.dataset.id, e.target.value);
        }
      });
    });

    root.querySelectorAll('[data-action="reboot"]').forEach((el) =>
      el.addEventListener("click", () => this._reboot(el.dataset.id))
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
    root.querySelector('[data-action="batch-remove"]')?.addEventListener("click", () => this._batchRemove());
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
  .name-input:hover, .name-input:focus {
    border-color: var(--divider-color, #e0e0e0);
    background: var(--secondary-background-color, #f5f5f5);
    outline: none;
  }

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
  ul.candidates { list-style: none; padding: 0; margin: 0 0 12px; max-height: 180px; overflow-y: auto; }
  ul.candidates li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--divider-color, #eee); }
`;

customElements.define("shelly-fleet-panel", ShellyFleetPanel);
