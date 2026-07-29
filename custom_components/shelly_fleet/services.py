"""Home Assistant services, so batch operations can be driven from automations
in addition to the panel's UI."""
from __future__ import annotations

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, TOGGLE_FEATURES

SERVICE_SET_FEATURE = "set_feature"
SERVICE_BATCH_SET_FEATURE = "batch_set_feature"
SERVICE_APPLY_CONFIG = "apply_config"
SERVICE_BATCH_APPLY_CONFIG = "batch_apply_config"
SERVICE_REBOOT = "reboot"
SERVICE_ZIGBEE_CLEAR = "zigbee_clear"
SERVICE_BATCH_ZIGBEE_CLEAR = "batch_zigbee_clear"

SET_FEATURE_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): cv.string,
        vol.Required("feature"): vol.In(TOGGLE_FEATURES),
        vol.Required("value"): cv.boolean,
    }
)

BATCH_SET_FEATURE_SCHEMA = vol.Schema(
    {
        vol.Required("device_ids"): vol.All(cv.ensure_list, [cv.string]),
        vol.Required("feature"): vol.In(TOGGLE_FEATURES),
        vol.Required("value"): cv.boolean,
    }
)

_CONFIG_SCHEMA = vol.Schema({vol.In(TOGGLE_FEATURES): cv.boolean})

APPLY_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): cv.string,
        vol.Required("config"): _CONFIG_SCHEMA,
    }
)

BATCH_APPLY_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Required("device_ids"): vol.All(cv.ensure_list, [cv.string]),
        vol.Required("config"): _CONFIG_SCHEMA,
    }
)

REBOOT_SCHEMA = vol.Schema({vol.Required("device_id"): cv.string})
ZIGBEE_CLEAR_SCHEMA = vol.Schema({vol.Required("device_id"): cv.string})
BATCH_ZIGBEE_CLEAR_SCHEMA = vol.Schema(
    {vol.Required("device_ids"): vol.All(cv.ensure_list, [cv.string])}
)


def _coordinator(hass: HomeAssistant):
    for value in hass.data.get(DOMAIN, {}).values():
        if isinstance(value, dict) and "coordinator" in value:
            return value["coordinator"]
    raise RuntimeError("Shelly Fleet Manager is not set up")


def async_register_services(hass: HomeAssistant) -> None:
    async def handle_set_feature(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        await coordinator.async_set_feature(
            call.data["device_id"], call.data["feature"], call.data["value"]
        )
        await coordinator.async_request_refresh()

    async def handle_batch_set_feature(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        for device_id in call.data["device_ids"]:
            await coordinator.async_set_feature(device_id, call.data["feature"], call.data["value"])
        await coordinator.async_request_refresh()

    async def handle_apply_config(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        await coordinator.async_apply_config(call.data["device_id"], call.data["config"])
        await coordinator.async_request_refresh()

    async def handle_batch_apply_config(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        for device_id in call.data["device_ids"]:
            await coordinator.async_apply_config(device_id, call.data["config"])
        await coordinator.async_request_refresh()

    async def handle_reboot(call: ServiceCall) -> None:
        await _coordinator(hass).async_reboot(call.data["device_id"])

    async def handle_zigbee_clear(call: ServiceCall) -> None:
        await _coordinator(hass).async_zigbee_clear(call.data["device_id"])

    async def handle_batch_zigbee_clear(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        for device_id in call.data["device_ids"]:
            await coordinator.async_zigbee_clear(device_id)

    hass.services.async_register(
        DOMAIN, SERVICE_SET_FEATURE, handle_set_feature, schema=SET_FEATURE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_BATCH_SET_FEATURE,
        handle_batch_set_feature,
        schema=BATCH_SET_FEATURE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_APPLY_CONFIG, handle_apply_config, schema=APPLY_CONFIG_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_BATCH_APPLY_CONFIG,
        handle_batch_apply_config,
        schema=BATCH_APPLY_CONFIG_SCHEMA,
    )
    hass.services.async_register(DOMAIN, SERVICE_REBOOT, handle_reboot, schema=REBOOT_SCHEMA)
    hass.services.async_register(
        DOMAIN, SERVICE_ZIGBEE_CLEAR, handle_zigbee_clear, schema=ZIGBEE_CLEAR_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_BATCH_ZIGBEE_CLEAR,
        handle_batch_zigbee_clear,
        schema=BATCH_ZIGBEE_CLEAR_SCHEMA,
    )


def async_unregister_services(hass: HomeAssistant) -> None:
    for service in (
        SERVICE_SET_FEATURE,
        SERVICE_BATCH_SET_FEATURE,
        SERVICE_APPLY_CONFIG,
        SERVICE_BATCH_APPLY_CONFIG,
        SERVICE_REBOOT,
        SERVICE_ZIGBEE_CLEAR,
        SERVICE_BATCH_ZIGBEE_CLEAR,
    ):
        hass.services.async_remove(DOMAIN, service)
