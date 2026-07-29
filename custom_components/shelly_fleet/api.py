"""WebSocket API consumed by the Shelly Fleet sidebar panel."""
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from . import rpc_client as rpc
from .const import DOMAIN, TOGGLE_FEATURES
from .discovery import async_discover_ips

_LOGGER = logging.getLogger(__name__)

DEVICE_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional("name"): str,
        **{vol.Optional(feature): bool for feature in TOGGLE_FEATURES},
    }
)

BATCH_CONFIG_SCHEMA = vol.Schema({vol.Optional(feature): bool for feature in TOGGLE_FEATURES})


def _get_data(hass: HomeAssistant) -> dict:
    """Fetch this integration's single hub data (single_config_entry=true)."""
    for value in hass.data.get(DOMAIN, {}).values():
        if isinstance(value, dict) and "coordinator" in value:
            return value
    raise RuntimeError("Shelly Fleet Manager is not set up")


@callback
def async_register_websocket_api(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list_devices)
    websocket_api.async_register_command(hass, ws_discover)
    websocket_api.async_register_command(hass, ws_add_device)
    websocket_api.async_register_command(hass, ws_add_devices)
    websocket_api.async_register_command(hass, ws_remove_device)
    websocket_api.async_register_command(hass, ws_rename_device)
    websocket_api.async_register_command(hass, ws_set_feature)
    websocket_api.async_register_command(hass, ws_batch_set_feature)
    websocket_api.async_register_command(hass, ws_apply_device_config)
    websocket_api.async_register_command(hass, ws_batch_apply_config)
    websocket_api.async_register_command(hass, ws_reboot)
    websocket_api.async_register_command(hass, ws_batch_reboot)
    websocket_api.async_register_command(hass, ws_zigbee_clear)
    websocket_api.async_register_command(hass, ws_batch_zigbee_clear)
    websocket_api.async_register_command(hass, ws_refresh)


@websocket_api.websocket_command({vol.Required("type"): "shelly_fleet/list_devices"})
@websocket_api.async_response
async def ws_list_devices(hass, connection, msg):
    data = _get_data(hass)
    connection.send_result(msg["id"], {"devices": list(data["coordinator"].data.values())})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/discover",
        vol.Optional("scan_seconds", default=5): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_discover(hass, connection, msg):
    data = _get_data(hass)
    known_ips = {d["ip"] for d in data["store"].all()}
    ips = await async_discover_ips(hass, msg["scan_seconds"])

    candidates = []
    for ip in ips:
        if ip in known_ips:
            continue
        client = rpc.ShellyRpcClient(data["coordinator"].session, ip)
        try:
            info = await rpc.get_device_info(client)
        except Exception:  # noqa: BLE001 - unreachable/non-Shelly host during a LAN scan
            continue
        candidates.append(
            {
                "ip": ip,
                "id": info.get("id"),
                "model": info.get("model"),
                "gen": info.get("gen"),
                "name": info.get("id"),
            }
        )
    connection.send_result(msg["id"], {"candidates": candidates})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/add_device",
        vol.Required("ip"): str,
        vol.Optional("name"): str,
        vol.Optional("username"): str,
        vol.Optional("password"): str,
    }
)
@websocket_api.async_response
async def ws_add_device(hass, connection, msg):
    data = _get_data(hass)
    client = rpc.ShellyRpcClient(
        data["coordinator"].session, msg["ip"], msg.get("username"), msg.get("password")
    )
    try:
        info = await rpc.get_device_info(client)
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "cannot_connect", str(err))
        return

    device_id = info.get("id")
    if not device_id:
        connection.send_error(msg["id"], "no_device_id", "Device did not return an id")
        return

    entry = {"id": device_id, "ip": msg["ip"], "name": msg.get("name") or device_id}
    if msg.get("username"):
        entry["username"] = msg["username"]
    if msg.get("password"):
        entry["password"] = msg["password"]

    await data["store"].async_add(entry)
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"], {"id": device_id})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/add_devices",
        vol.Required("devices"): [
            vol.Schema(
                {
                    vol.Required("ip"): str,
                    vol.Optional("name"): str,
                    vol.Optional("username"): str,
                    vol.Optional("password"): str,
                }
            )
        ],
    }
)
@websocket_api.async_response
async def ws_add_devices(hass, connection, msg):
    """Add every candidate from a discovery scan in one shot ("Add All")."""
    data = _get_data(hass)
    results = await data["coordinator"].async_add_devices(msg["devices"])
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"], {"results": results})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "shelly_fleet/remove_device", vol.Required("device_id"): str}
)
@websocket_api.async_response
async def ws_remove_device(hass, connection, msg):
    data = _get_data(hass)
    await data["store"].async_remove(msg["device_id"])
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/rename_device",
        vol.Required("device_id"): str,
        vol.Required("name"): str,
    }
)
@websocket_api.async_response
async def ws_rename_device(hass, connection, msg):
    data = _get_data(hass)
    try:
        await data["coordinator"].async_rename(msg["device_id"], msg["name"])
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "rename_failed", str(err))
        return
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/set_feature",
        vol.Required("device_id"): str,
        vol.Required("feature"): vol.In(TOGGLE_FEATURES),
        vol.Required("value"): bool,
    }
)
@websocket_api.async_response
async def ws_set_feature(hass, connection, msg):
    data = _get_data(hass)
    try:
        await data["coordinator"].async_set_feature(msg["device_id"], msg["feature"], msg["value"])
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "set_feature_failed", str(err))
        return
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/batch_set_feature",
        vol.Required("device_ids"): [str],
        vol.Required("feature"): vol.In(TOGGLE_FEATURES),
        vol.Required("value"): bool,
    }
)
@websocket_api.async_response
async def ws_batch_set_feature(hass, connection, msg):
    data = _get_data(hass)
    coordinator = data["coordinator"]
    results = {}
    for device_id in msg["device_ids"]:
        try:
            await coordinator.async_set_feature(device_id, msg["feature"], msg["value"])
            results[device_id] = {"ok": True}
        except Exception as err:  # noqa: BLE001
            results[device_id] = {"ok": False, "error": str(err)}
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"results": results})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "shelly_fleet/reboot", vol.Required("device_id"): str}
)
@websocket_api.async_response
async def ws_reboot(hass, connection, msg):
    data = _get_data(hass)
    try:
        await data["coordinator"].async_reboot(msg["device_id"])
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "reboot_failed", str(err))
        return
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "shelly_fleet/batch_reboot", vol.Required("device_ids"): [str]}
)
@websocket_api.async_response
async def ws_batch_reboot(hass, connection, msg):
    data = _get_data(hass)
    coordinator = data["coordinator"]
    results = {}
    for device_id in msg["device_ids"]:
        try:
            await coordinator.async_reboot(device_id)
            results[device_id] = {"ok": True}
        except Exception as err:  # noqa: BLE001
            results[device_id] = {"ok": False, "error": str(err)}
    connection.send_result(msg["id"], {"results": results})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/apply_device_config",
        vol.Required("device_id"): str,
        vol.Required("config"): DEVICE_CONFIG_SCHEMA,
    }
)
@websocket_api.async_response
async def ws_apply_device_config(hass, connection, msg):
    """Apply an imported/edited config (name and/or any toggle feature) to
    one device in a single round trip — used by config import and by the
    editable table's inline saves."""
    data = _get_data(hass)
    try:
        await data["coordinator"].async_apply_config(msg["device_id"], msg["config"])
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "apply_config_failed", str(err))
        return
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "shelly_fleet/batch_apply_config",
        vol.Required("device_ids"): [str],
        vol.Required("config"): BATCH_CONFIG_SCHEMA,
    }
)
@websocket_api.async_response
async def ws_batch_apply_config(hass, connection, msg):
    """Apply the same set of toggle features to every selected device."""
    data = _get_data(hass)
    coordinator = data["coordinator"]
    results = {}
    for device_id in msg["device_ids"]:
        try:
            await coordinator.async_apply_config(device_id, msg["config"])
            results[device_id] = {"ok": True}
        except Exception as err:  # noqa: BLE001
            results[device_id] = {"ok": False, "error": str(err)}
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"results": results})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "shelly_fleet/zigbee_clear", vol.Required("device_id"): str}
)
@websocket_api.async_response
async def ws_zigbee_clear(hass, connection, msg):
    data = _get_data(hass)
    try:
        await data["coordinator"].async_zigbee_clear(msg["device_id"])
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "zigbee_clear_failed", str(err))
        return
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "shelly_fleet/batch_zigbee_clear", vol.Required("device_ids"): [str]}
)
@websocket_api.async_response
async def ws_batch_zigbee_clear(hass, connection, msg):
    data = _get_data(hass)
    coordinator = data["coordinator"]
    results = {}
    for device_id in msg["device_ids"]:
        try:
            await coordinator.async_zigbee_clear(device_id)
            results[device_id] = {"ok": True}
        except Exception as err:  # noqa: BLE001
            results[device_id] = {"ok": False, "error": str(err)}
    connection.send_result(msg["id"], {"results": results})


@websocket_api.websocket_command({vol.Required("type"): "shelly_fleet/refresh"})
@websocket_api.async_response
async def ws_refresh(hass, connection, msg):
    data = _get_data(hass)
    await data["coordinator"].async_request_refresh()
    connection.send_result(msg["id"], {"devices": list(data["coordinator"].data.values())})
