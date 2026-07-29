"""Persistent registry of devices the user has added to the fleet manager.

This is deliberately independent of HA's config-entry/entity-registry model:
devices are added/removed from the single-page panel at runtime, not through
a config flow per device, so a plain HA `Store` file is the right fit.
"""
from __future__ import annotations

from typing import Any, TypedDict

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION


class DeviceEntry(TypedDict, total=False):
    id: str  # Shelly device id (from Shelly.GetDeviceInfo), stable identifier
    ip: str
    name: str
    username: str
    password: str


class DeviceStore:
    """Wraps an HA Store holding the list of registered devices."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, list[DeviceEntry]]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY
        )
        self._devices: dict[str, DeviceEntry] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load()
        devices = (data or {}).get("devices", [])
        self._devices = {d["id"]: d for d in devices if "id" in d}

    def all(self) -> list[DeviceEntry]:
        return list(self._devices.values())

    def get(self, device_id: str) -> DeviceEntry | None:
        return self._devices.get(device_id)

    async def async_add(self, entry: DeviceEntry) -> None:
        self._devices[entry["id"]] = entry
        await self._async_save()

    async def async_update(self, device_id: str, changes: dict[str, Any]) -> None:
        if device_id not in self._devices:
            return
        self._devices[device_id].update(changes)  # type: ignore[typeddict-item]
        await self._async_save()

    async def async_remove(self, device_id: str) -> None:
        self._devices.pop(device_id, None)
        await self._async_save()

    async def _async_save(self) -> None:
        await self._store.async_save({"devices": list(self._devices.values())})
