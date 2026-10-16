"""User-supplied device photos.

The panel ships original drawn icons per device family. Users can override
them with their own photos in ``<config>/www/shelly_fleet/`` (served by HA at
``/local/shelly_fleet/``), which survives HACS updates, unlike files inside
this integration's folder:

- ``<device id>.<ext>`` — one specific device (e.g. ``shellyplus1pm-a8032ab12345.jpg``)
- ``<model>.<ext>`` — every device of that model (e.g. ``SNSW-001P16EU.png``)

The directory is scanned server-side so the panel only ever requests images
that exist, instead of probing (and 404-ing) on every render.
"""
from __future__ import annotations

import os
from typing import Any

from homeassistant.core import HomeAssistant

PHOTO_DIR = "www/shelly_fleet"
PHOTO_URL_BASE = "/local/shelly_fleet"
PHOTO_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".svg")


def _scan(path: str) -> dict[str, str]:
    """Map lower-cased file stem → URL (with mtime so replacing a photo shows up)."""
    try:
        entries = list(os.scandir(path))
    except (FileNotFoundError, NotADirectoryError):
        return {}
    photos: dict[str, str] = {}
    for entry in entries:
        stem, ext = os.path.splitext(entry.name)
        if ext.lower() in PHOTO_EXTENSIONS and entry.is_file():
            mtime = int(entry.stat().st_mtime)
            photos[stem.lower()] = f"{PHOTO_URL_BASE}/{entry.name}?v={mtime}"
    return photos


async def async_attach_photo_urls(
    hass: HomeAssistant, devices: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Return copies of ``devices`` with ``photo_url`` set where a photo exists."""
    photos = await hass.async_add_executor_job(_scan, hass.config.path(PHOTO_DIR))
    result = []
    for device in devices:
        url = photos.get(str(device.get("id", "")).lower()) or photos.get(
            str(device.get("model") or "").lower()
        )
        result.append({**device, "photo_url": url})
    return result
