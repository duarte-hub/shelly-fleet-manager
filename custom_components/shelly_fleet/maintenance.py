"""Maintenance settings and scheduled fleet reboots.

Schedules run inside HA (not as on-device ``Schedule.Create`` jobs) so the
whole fleet is managed from one place, reboots can be staggered so every
device doesn't drop off the network at once, and each run's outcome is
recorded for the panel. Times are interpreted in HA's configured time zone.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, TypedDict

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    DEFAULT_POLL_INTERVAL,
    MAINTENANCE_STORAGE_KEY,
    STORAGE_VERSION,
)
from .coordinator import ShellyFleetCoordinator

_LOGGER = logging.getLogger(__name__)


class RebootSchedule(TypedDict, total=False):
    id: str
    name: str
    enabled: bool
    time: str  # "HH:MM", HA local time
    days: list[int]  # 0 = Monday … 6 = Sunday
    device_ids: list[str]
    stagger_seconds: int  # delay between consecutive device reboots
    last_run: str | None  # ISO timestamp
    last_result: dict[str, Any] | None


class MaintenanceManager:
    """Owns the poll-interval setting and the reboot schedules."""

    def __init__(self, hass: HomeAssistant, coordinator: ShellyFleetCoordinator) -> None:
        self._hass = hass
        self._coordinator = coordinator
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, MAINTENANCE_STORAGE_KEY)
        self._poll_interval: int = DEFAULT_POLL_INTERVAL
        self._schedules: dict[str, RebootSchedule] = {}
        self._running: set[str] = set()
        self._unsub_tick: CALLBACK_TYPE | None = None

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self._poll_interval = int(data.get("poll_interval", DEFAULT_POLL_INTERVAL))
        self._schedules = {s["id"]: s for s in data.get("reboot_schedules", []) if "id" in s}
        self._apply_poll_interval()

    @callback
    def async_start(self) -> None:
        self._unsub_tick = async_track_time_change(self._hass, self._async_tick, second=0)

    @callback
    def async_stop(self) -> None:
        if self._unsub_tick:
            self._unsub_tick()
            self._unsub_tick = None

    # --- Poll interval ----------------------------------------------------

    @property
    def poll_interval(self) -> int:
        """Seconds between automatic device polls; 0 = manual refresh only."""
        return self._poll_interval

    async def async_set_poll_interval(self, seconds: int) -> None:
        self._poll_interval = seconds
        self._apply_poll_interval()
        await self._async_save()

    def _apply_poll_interval(self) -> None:
        self._coordinator.update_interval = (
            timedelta(seconds=self._poll_interval) if self._poll_interval > 0 else None
        )

    # --- Reboot schedules -------------------------------------------------

    def as_dict(self) -> dict[str, Any]:
        return {
            "poll_interval": self._poll_interval,
            "time_zone": str(dt_util.get_default_time_zone()),
            "reboot_schedules": [
                {**s, "running": s["id"] in self._running} for s in self._schedules.values()
            ],
        }

    async def async_save_schedule(self, schedule: dict[str, Any]) -> str:
        schedule_id = schedule.get("id") or uuid.uuid4().hex
        existing = self._schedules.get(schedule_id, {})
        self._schedules[schedule_id] = {
            "last_run": None,
            "last_result": None,
            **existing,
            **schedule,
            "id": schedule_id,
        }
        await self._async_save()
        return schedule_id

    async def async_delete_schedule(self, schedule_id: str) -> None:
        self._schedules.pop(schedule_id, None)
        await self._async_save()

    def async_run_now(self, schedule_id: str) -> None:
        if schedule_id not in self._schedules:
            raise KeyError(schedule_id)
        self._start_run(schedule_id)

    async def _async_tick(self, _now: datetime) -> None:
        now = dt_util.now()
        hhmm = now.strftime("%H:%M")
        for schedule in self._schedules.values():
            if (
                schedule.get("enabled")
                and schedule.get("time") == hhmm
                and now.weekday() in schedule.get("days", [])
            ):
                self._start_run(schedule["id"])

    def _start_run(self, schedule_id: str) -> None:
        if schedule_id in self._running:
            _LOGGER.debug("Reboot schedule %s already running; skipping", schedule_id)
            return
        self._running.add(schedule_id)
        self._hass.async_create_background_task(
            self._async_run(schedule_id), f"shelly_fleet reboot schedule {schedule_id}"
        )

    async def _async_run(self, schedule_id: str) -> None:
        schedule = self._schedules[schedule_id]
        errors: dict[str, str] = {}
        ok = 0
        try:
            for index, device_id in enumerate(schedule.get("device_ids", [])):
                if index > 0 and schedule.get("stagger_seconds", 0) > 0:
                    await asyncio.sleep(schedule["stagger_seconds"])
                try:
                    await self._coordinator.async_reboot(device_id)
                    ok += 1
                except KeyError:
                    errors[device_id] = "Device no longer in fleet"
                except Exception as err:  # noqa: BLE001 - record and carry on with the rest
                    errors[device_id] = str(err) or type(err).__name__
            _LOGGER.info(
                "Reboot schedule '%s' finished: %d ok, %d failed",
                schedule.get("name"), ok, len(errors),
            )
        finally:
            self._running.discard(schedule_id)
            # The schedule may have been deleted mid-run.
            if schedule_id in self._schedules:
                self._schedules[schedule_id]["last_run"] = dt_util.now().isoformat()
                self._schedules[schedule_id]["last_result"] = {
                    "ok": ok,
                    "failed": len(errors),
                    "errors": errors,
                }
                await self._async_save()

    async def _async_save(self) -> None:
        await self._store.async_save(
            {
                "poll_interval": self._poll_interval,
                "reboot_schedules": list(self._schedules.values()),
            }
        )
