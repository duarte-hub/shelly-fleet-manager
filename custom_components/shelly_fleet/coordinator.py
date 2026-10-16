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
    TOGGLE_FEATURES,
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

        # A coroutine listener runs on the event loop; a plain lambda would be
        # run in an executor thread, where hass.async_create_task is unsafe.
        async def _close_session(_event) -> None:
            await self._session.close()

        hass.bus.async_listen_once("homeassistant_stop", _close_session)

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
            sys_cfg, cloud_cfg, mqtt_cfg, ble_cfg, wifi_status = await asyncio.gather(
                rpc.get_sys_config(client),
                rpc.get_cloud_config(client),
                rpc.get_mqtt_config(client),
                rpc.get_ble_config(client),
                self._optional(rpc.get_wifi_status(client)),
            )
        except rpc.ShellyAuthRequired:
            return self._offline(entry, "auth_required")
        except (rpc.ShellyConnectionError, rpc.ShellyRpcError) as err:
            return self._offline(entry, str(err))

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
            "rssi": wifi_status.get("rssi"),
            "ssid": wifi_status.get("ssid"),
        }

    def _offline(self, entry: DeviceEntry, error: str) -> dict[str, Any]:
        # Keep the last known identity so the panel can still show the right
        # model / device icon while the device is unreachable.
        last = (self.data or {}).get(entry["id"], {})
        return {
            "id": entry["id"],
            "ip": entry["ip"],
            "name": entry.get("name", entry["ip"]),
            "online": False,
            "error": error,
            "model": last.get("model"),
            "app": last.get("app"),
            "gen": last.get("gen"),
        }

    @staticmethod
    async def _optional(coro) -> dict[str, Any]:
        """Await a status read whose failure shouldn't mark the device offline
        (e.g. a Wi-Fi-less, Ethernet-only model rejecting Wifi.GetStatus)."""
        try:
            return await coro or {}
        except rpc.ShellyRpcError:
            return {}

    @staticmethod
    async def _apply_feature(client: rpc.ShellyRpcClient, feature: str, value: bool) -> None:
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

    def _entry_or_raise(self, device_id: str) -> DeviceEntry:
        entry = self.store.get(device_id)
        if entry is None:
            raise KeyError(device_id)
        return entry

    async def async_set_feature(self, device_id: str, feature: str, value: bool) -> None:
        client = self.client_for(self._entry_or_raise(device_id))
        await self._apply_feature(client, feature, value)

    async def async_apply_config(self, device_id: str, config: dict[str, Any]) -> None:
        """Apply a partial config (any of the toggle features, and/or a new
        name) to one device in a single client session, so a digest-auth
        challenge is only negotiated once per device."""
        entry = self._entry_or_raise(device_id)
        client = self.client_for(entry)

        name = config.get("name")
        if name:
            await rpc.set_sys_config(client, {"device": {"name": name}})
            await self.store.async_update(device_id, {"name": name})

        for feature in TOGGLE_FEATURES:
            if feature in config:
                await self._apply_feature(client, feature, bool(config[feature]))

    async def async_rename(self, device_id: str, name: str) -> None:
        client = self.client_for(self._entry_or_raise(device_id))
        await rpc.set_sys_config(client, {"device": {"name": name}})
        await self.store.async_update(device_id, {"name": name})

    async def async_reboot(self, device_id: str) -> None:
        await rpc.reboot(self.client_for(self._entry_or_raise(device_id)))

    async def async_zigbee_clear(self, device_id: str) -> None:
        await rpc.zigbee_clear(self.client_for(self._entry_or_raise(device_id)))

    async def async_add_devices(
        self, devices: list[dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        """Probe and register multiple devices (used by discovery's Add All).

        Returns a per-ip result dict so the panel can report which ones
        failed without aborting the whole batch.
        """
        results: dict[str, dict[str, Any]] = {}
        for device in devices:
            ip = device["ip"]
            client = rpc.ShellyRpcClient(
                self._session, ip, device.get("username"), device.get("password")
            )
            try:
                info = await rpc.get_device_info(client)
            except (rpc.ShellyConnectionError, rpc.ShellyRpcError, rpc.ShellyAuthRequired) as err:
                results[ip] = {"ok": False, "error": str(err)}
                continue

            device_id = info.get("id")
            if not device_id:
                results[ip] = {"ok": False, "error": "Device did not return an id"}
                continue

            entry: DeviceEntry = {"id": device_id, "ip": ip, "name": device.get("name") or device_id}
            if device.get("username"):
                entry["username"] = device["username"]
            if device.get("password"):
                entry["password"] = device["password"]

            await self.store.async_add(entry)
            results[ip] = {"ok": True, "id": device_id}

        return results

    async def async_shutdown(self) -> None:
        await self._session.close()
        await super().async_shutdown()
