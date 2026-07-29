"""mDNS discovery of Shelly Gen2/3/4 devices on the local network.

Reuses Home Assistant's shared zeroconf instance rather than opening a new
multicast socket, per HA's integration guidelines.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging

from homeassistant.components import zeroconf as ha_zeroconf
from homeassistant.core import HomeAssistant
from zeroconf import IPVersion
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo

from .const import MDNS_SERVICE_TYPE

_LOGGER = logging.getLogger(__name__)

DEFAULT_SCAN_SECONDS = 5


async def async_discover_ips(hass: HomeAssistant, scan_seconds: float = DEFAULT_SCAN_SECONDS) -> list[str]:
    """Browse for Shelly devices and return their IPv4 addresses."""
    aiozc = await ha_zeroconf.async_get_async_instance(hass)
    found: set[str] = set()
    seen_names: set[str] = set()

    async def _on_service_state_change_wrapper(name: str) -> None:
        if name in seen_names:
            return
        seen_names.add(name)
        info = AsyncServiceInfo(MDNS_SERVICE_TYPE, name)
        try:
            resolved = await info.async_request(aiozc.zeroconf, 3000)
        except Exception:  # noqa: BLE001 - resolution failures are routine on LAN scans
            resolved = False
        if not resolved:
            return
        for addr in info.parsed_scoped_addresses(IPVersion.V4Only):
            try:
                ipaddress.IPv4Address(addr)
            except ValueError:
                continue
            found.add(addr)

    pending: set[asyncio.Task] = set()

    def _on_change(zeroconf, service_type, name, state_change) -> None:  # noqa: ANN001
        task = hass.async_create_task(_on_service_state_change_wrapper(name))
        pending.add(task)
        task.add_done_callback(pending.discard)

    browser = AsyncServiceBrowser(aiozc.zeroconf, MDNS_SERVICE_TYPE, handlers=[_on_change])
    try:
        await asyncio.sleep(scan_seconds)
        if pending:
            await asyncio.wait(pending, timeout=3)
    finally:
        await browser.async_cancel()

    return sorted(found)
