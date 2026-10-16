"""Constants for Shelly Fleet Manager."""
from __future__ import annotations

DOMAIN = "shelly_fleet"
PLATFORMS: list[str] = []

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_devices"
MAINTENANCE_STORAGE_KEY = f"{DOMAIN}_maintenance"

PANEL_URL = "shelly-fleet-panel"
PANEL_TITLE = "Shelly Fleet"
PANEL_ICON = "mdi:lightning-bolt-circle"
PANEL_JS_FILENAME = "shelly-fleet-panel.js"

CONF_DEVICES = "devices"
CONF_IP = "ip"
CONF_ID = "id"
CONF_NAME = "name"
CONF_USERNAME = "username"
CONF_PASSWORD = "password"

DEFAULT_POLL_INTERVAL = 15  # seconds; user-configurable from the Maintenance tab
MIN_POLL_INTERVAL = 5  # seconds; 0 is also allowed, meaning manual refresh only

# Device-level config features exposed for inline edit + batch toggling.
# Each maps to a Shelly RPC component/config path.
FEATURE_ECO_MODE = "eco_mode"
FEATURE_CLOUD = "cloud"
FEATURE_MQTT = "mqtt"
FEATURE_BLE = "ble"
FEATURE_DISCOVERABLE = "discoverable"

TOGGLE_FEATURES = (
    FEATURE_ECO_MODE,
    FEATURE_CLOUD,
    FEATURE_MQTT,
    FEATURE_BLE,
    FEATURE_DISCOVERABLE,
)

MDNS_SERVICE_TYPE = "_shelly._tcp.local."

EVENT_DEVICES_UPDATED = f"{DOMAIN}_devices_updated"
