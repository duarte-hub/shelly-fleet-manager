"""Shelly Fleet Manager: fleet-wide batch config and a single-page editable
table for Shelly Gen2/3/4 devices, complementing HA's core Shelly integration.
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api, services
from .const import DOMAIN
from .coordinator import ShellyFleetCoordinator
from .maintenance import MaintenanceManager
from .panel import async_register_panel
from .store import DeviceStore

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = DeviceStore(hass)
    await store.async_load()

    coordinator = ShellyFleetCoordinator(hass, store)
    maintenance = MaintenanceManager(hass, coordinator)
    await maintenance.async_load()
    await coordinator.async_config_entry_first_refresh()
    maintenance.async_start()

    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data[entry.entry_id] = {
        "store": store,
        "coordinator": coordinator,
        "maintenance": maintenance,
    }

    if not domain_data.get("_panel_registered"):
        await async_register_panel(hass)
        domain_data["_panel_registered"] = True

    if not domain_data.get("_ws_registered"):
        api.async_register_websocket_api(hass)
        domain_data["_ws_registered"] = True

    services.async_register_services(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    domain_data = hass.data.get(DOMAIN, {})
    data = domain_data.pop(entry.entry_id, None)
    if data:
        data["maintenance"].async_stop()
        await data["coordinator"].async_shutdown()
    services.async_unregister_services(hass)
    return True
