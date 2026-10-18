"""Fleet firmware: check every device for updates and start OTA updates.

Results live in memory only: a check is cheap to redo, and what's available
changes on Shelly's side anyway. An update is tracked as "updating" from the
moment it's started until the device reports the target version on a later
poll (or a timeout passes), so the panel can show progress.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any, TypedDict

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .coordinator import ShellyFleetCoordinator

_LOGGER = logging.getLogger(__name__)

STAGES = ("stable", "beta")
CHECK_CONCURRENCY = 8
# Download + flash + reboot normally takes 1–3 minutes; give slow links room.
UPDATE_TIMEOUT = timedelta(minutes=15)
# Re-poll this often while updates are in flight, whatever the poll interval
# setting (it may be "manual only"), so progress resolves promptly.
WATCH_INTERVAL = 20  # seconds


class DeviceFirmware(TypedDict, total=False):
    stable: str | None  # newer stable version on offer, if any
    beta: str | None  # newer beta version on offer, if any
    checked: str  # ISO timestamp of the last check of this device
    error: str | None  # why the last check failed
    updating: dict[str, str] | None  # {"stage", "target", "started"} while in progress
    update_error: str | None  # why the last update failed / timed out


class FirmwareManager:
    def __init__(self, hass: HomeAssistant, coordinator: ShellyFleetCoordinator) -> None:
        self._hass = hass
        self._coordinator = coordinator
        self._devices: dict[str, DeviceFirmware] = {}
        self._last_check: str | None = None
        self._checking = False
        self._watch_task: asyncio.Task | None = None

    def async_stop(self) -> None:
        if self._watch_task:
            self._watch_task.cancel()
            self._watch_task = None

    def as_dict(self) -> dict[str, Any]:
        self._settle_updates()
        return {
            "last_check": self._last_check,
            "checking": self._checking,
            "devices": self._devices,
        }

    def _settle_updates(self) -> None:
        """Resolve in-progress updates against the latest poll."""
        now = dt_util.utcnow()
        polled = self._coordinator.data or {}
        for device_id, fw in self._devices.items():
            updating = fw.get("updating")
            if not updating:
                continue
            device = polled.get(device_id, {})
            if device.get("online") and device.get("fw_version") == updating["target"]:
                fw["updating"] = None
                fw[updating["stage"]] = None  # that offer is now installed
                if updating["stage"] == "beta" and fw.get("stable") == updating["target"]:
                    fw["stable"] = None
            elif now - dt_util.parse_datetime(updating["started"]) > UPDATE_TIMEOUT:
                fw["updating"] = None
                fw["update_error"] = (
                    f"Still on {device.get('fw_version') or 'unknown version'} after "
                    f"{int(UPDATE_TIMEOUT.total_seconds() // 60)} min"
                )

    async def async_check(self, device_ids: list[str] | None = None) -> None:
        """Check the given devices (default: every online device) for updates."""
        polled = self._coordinator.data or {}
        if device_ids is None:
            device_ids = [i for i, d in polled.items() if d.get("online")]
        semaphore = asyncio.Semaphore(CHECK_CONCURRENCY)

        async def check(device_id: str) -> None:
            async with semaphore:
                fw = self._devices.setdefault(device_id, {})
                try:
                    result = await self._coordinator.async_check_for_update(device_id)
                except Exception as err:  # noqa: BLE001 - recorded per device
                    fw["error"] = str(err) or type(err).__name__
                else:
                    fw["error"] = None
                    for stage in STAGES:
                        fw[stage] = (result.get(stage) or {}).get("version")
                fw["checked"] = dt_util.utcnow().isoformat()

        self._checking = True
        try:
            await asyncio.gather(*(check(i) for i in device_ids))
        finally:
            self._checking = False
        self._last_check = dt_util.utcnow().isoformat()

    async def async_update(self, device_ids: list[str], stage: str) -> dict[str, dict[str, Any]]:
        """Start an OTA update on each device that has ``stage`` firmware on offer."""
        results: dict[str, dict[str, Any]] = {}
        for device_id in device_ids:
            fw = self._devices.setdefault(device_id, {})
            target = fw.get(stage)
            if not target:
                results[device_id] = {"ok": False, "error": f"No {stage} update available"}
                continue
            if fw.get("updating"):
                results[device_id] = {"ok": False, "error": "Already updating"}
                continue
            try:
                await self._coordinator.async_update_firmware(device_id, stage)
            except Exception as err:  # noqa: BLE001 - recorded per device
                fw["update_error"] = str(err) or type(err).__name__
                results[device_id] = {"ok": False, "error": fw["update_error"]}
                continue
            fw["update_error"] = None
            fw["updating"] = {
                "stage": stage,
                "target": target,
                "started": dt_util.utcnow().isoformat(),
            }
            results[device_id] = {"ok": True}
            _LOGGER.info("Started %s firmware update of %s to %s", stage, device_id, target)
        self._ensure_watching()
        return results

    def _any_updating(self) -> bool:
        return any(fw.get("updating") for fw in self._devices.values())

    def _ensure_watching(self) -> None:
        if self._watch_task or not self._any_updating():
            return
        self._watch_task = self._hass.async_create_background_task(
            self._async_watch(), "shelly_fleet firmware watch"
        )

    async def _async_watch(self) -> None:
        try:
            while self._any_updating():
                await asyncio.sleep(WATCH_INTERVAL)
                await self._coordinator.async_refresh()
                self._settle_updates()
        finally:
            self._watch_task = None
