"""Fleet-wide polling coordinator.

Polls every registered device's identity + settings on an interval and keeps
an in-memory snapshot the panel reads via the WebSocket API. One coordinator
for the whole fleet (not one per device) since the panel always wants the
full table, not a single entity's state.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from . import rpc_client as rpc
from .const import (
    DEFAULT_POLL_INTERVAL,
    DOMAIN,
    FEATURE_BLE,
    FEATURE_CLOUD,
    FEATURE_DISCOVERABLE,
    FEATURE_ECO_MODE,
    FEATURE_MQTT,
)
from .store import DeviceEntry, DeviceStore

_LOGGER = logging.getLogger(__name__)


class ShellyFleetCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Polls all registered devices and exposes a dict keyed by device id."""

    def __init__(self, hass: HomeAssistant, store: DeviceStore) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=DEFAULT_POLL_INTERVAL),
        )
        self.store = store
        self._session = aiohttp.ClientSession()
        hass.bus.async_listen_once(
            "homeassistant_stop", lambda _event: hass.async_create_task(self._session.close())
        )

    @property
    def session(self) -> aiohttp.ClientSession:
        return self._session

    def client_for(self, entry: DeviceEntry) -> rpc.ShellyRpcClient:
        return rpc.ShellyRpcClient(
            self._session,
            entry["ip"],
            entry.get("username"),
            entry.get("password"),
        )

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        entries = self.store.all()
        results = await asyncio.gather(
            *(self._poll_device(entry) for entry in entries),
            return_exceptions=False,
        )
        return {entry["id"]: result for entry, result in zip(entries, results)}

    async def _poll_device(self, entry: DeviceEntry) -> dict[str, Any]:
        client = self.client_for(entry)
        try:
            info = await rpc.get_device_info(client)
            sys_cfg, cloud_cfg, mqtt_cfg, ble_cfg = await asyncio.gather(
                rpc.get_sys_config(client),
                rpc.get_cloud_config(client),
                rpc.get_mqtt_config(client),
                rpc.get_ble_config(client),
            )
        except rpc.ShellyAuthRequired:
            return {
                "id": entry["id"],
                "ip": entry["ip"],
                "name": entry.get("name", entry["ip"]),
                "online": False,
                "error": "auth_required",
            }
        except (rpc.ShellyConnectionError, rpc.ShellyRpcError) as err:
            return {
                "id": entry["id"],
                "ip": entry["ip"],
                "name": entry.get("name", entry["ip"]),
                "online": False,
                "error": str(err),
            }

        device = sys_cfg.get("device", {})
        return {
            "id": info.get("id", entry["id"]),
            "ip": entry["ip"],
            "online": True,
            "error": None,
            "name": device.get("name") or entry.get("name") or entry["ip"],
            "model": info.get("model"),
            "app": info.get("app"),
            "gen": info.get("gen"),
            "fw_id": info.get("fw_id"),
            "fw_version": info.get("ver"),
            "mac": info.get("mac"),
            "eco_mode": bool(device.get("eco_mode", False)),
            "discoverable": bool(device.get("discoverable", True)),
            "cloud": bool(cloud_cfg.get("enable", False)),
            "mqtt": bool(mqtt_cfg.get("enable", False)),
            "ble": bool(ble_cfg.get("enable", False)),
        }

    async def async_set_feature(self, device_id: str, feature: str, value: bool) -> None:
        entry = self.store.get(device_id)
        if entry is None:
            raise KeyError(device_id)
        client = self.client_for(entry)
        if feature == FEATURE_ECO_MODE:
            await rpc.set_sys_config(client, {"device": {"eco_mode": value}})
        elif feature == FEATURE_DISCOVERABLE:
            await rpc.set_sys_config(client, {"device": {"discoverable": value}})
        elif feature == FEATURE_CLOUD:
            await rpc.set_cloud_config(client, value)
        elif feature == FEATURE_MQTT:
            await rpc.set_mqtt_config(client, value)
        elif feature == FEATURE_BLE:
            await rpc.set_ble_config(client, value)
        else:
            raise ValueError(f"Unknown feature: {feature}")

    async def async_rename(self, device_id: str, name: str) -> None:
        entry = self.store.get(device_id)
        if entry is None:
            raise KeyError(device_id)
        client = self.client_for(entry)
        await rpc.set_sys_config(client, {"device": {"name": name}})
        await self.store.async_update(device_id, {"name": name})

    async def async_reboot(self, device_id: str) -> None:
        entry = self.store.get(device_id)
        if entry is None:
            raise KeyError(device_id)
        await rpc.reboot(self.client_for(entry))

    async def async_shutdown(self) -> None:
        await self._session.close()
        await super().async_shutdown()
