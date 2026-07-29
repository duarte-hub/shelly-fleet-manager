"""Config flow for Shelly Fleet Manager.

Single-instance hub with no fields: devices themselves are added later from
the panel (IP + optional credentials), not through this flow.
"""
from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class ShellyFleetConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle creation of the single Shelly Fleet Manager hub entry."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> config_entries.ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="Shelly Fleet Manager", data={})

        return self.async_show_form(step_id="user")
