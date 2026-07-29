"""Registers the Shelly Fleet sidebar panel and serves its static JS."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import PANEL_ICON, PANEL_JS_FILENAME, PANEL_TITLE, PANEL_URL

_LOGGER = logging.getLogger(__name__)

STATIC_URL_BASE = "/shelly_fleet_static"


async def async_register_panel(hass: HomeAssistant) -> None:
    www_dir = Path(__file__).parent / "www"

    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL_BASE, str(www_dir), cache_headers=False)]
    )

    try:
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL,
            webcomponent_name="shelly-fleet-panel",
            module_url=f"{STATIC_URL_BASE}/{PANEL_JS_FILENAME}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=True,
        )
    except ValueError:
        _LOGGER.debug("Shelly Fleet panel already registered")
