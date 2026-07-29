"""Minimal async JSON-RPC 2.0 client for Shelly Gen2/3/4 devices.

Implements the digest-style authentication documented for the Shelly RPC
API (https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/):
the device challenges an unauthenticated call with a 401 RPC error whose
``message`` is itself a JSON string carrying ``realm``/``nonce``, and the
client answers with an RFC 7616-flavoured SHA-256 response computed over
fixed placeholder method/URI strings (Shelly's RPC calls have no real HTTP
method/URI to hash, unlike plain HTTP digest auth).

This has been implemented against Shelly's published spec but not verified
against every firmware revision — if a real device rejects the computed
response, check the exact field names in the 401 challenge payload first.
"""
from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import logging
import random
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

RPC_TIMEOUT = 10


class ShellyAuthRequired(Exception):
    """Device requires auth and no/invalid credentials were supplied."""


class ShellyRpcError(Exception):
    """A JSON-RPC error response (other than an auth challenge)."""

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"RPC error {code}: {message}")


class ShellyConnectionError(Exception):
    """The device could not be reached or returned an unparsable response."""


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class ShellyRpcClient:
    """Async JSON-RPC 2.0 client for a single Shelly Gen2/3/4 device."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self._session = session
        self.host = host
        self._username = username or "admin"
        self._password = password
        self._id_counter = itertools.count(1)
        self._auth_ctx: dict[str, Any] | None = None

    @property
    def _url(self) -> str:
        return f"http://{self.host}/rpc"

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Call an RPC method, transparently handling the auth challenge."""
        payload: dict[str, Any] = {"id": next(self._id_counter), "method": method}
        if params is not None:
            payload["params"] = params
        if self._auth_ctx is not None:
            payload["auth"] = self._build_auth_block()

        data = await self._post(payload)

        if "error" in data:
            error = data["error"]
            if error.get("code") == 401:
                if not self._password:
                    raise ShellyAuthRequired(f"{self.host} requires authentication")
                self._auth_ctx = self._parse_challenge(error.get("message", "{}"))
                payload["auth"] = self._build_auth_block()
                data = await self._post(payload)
                if "error" in data:
                    err = data["error"]
                    raise ShellyRpcError(err.get("code", -1), err.get("message", ""))
            else:
                raise ShellyRpcError(error.get("code", -1), error.get("message", ""))

        return data.get("result")

    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            async with self._session.post(
                self._url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=RPC_TIMEOUT),
            ) as resp:
                text = await resp.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise ShellyConnectionError(f"Cannot reach {self.host}: {err}") from err

        try:
            return json.loads(text)
        except json.JSONDecodeError as err:
            raise ShellyConnectionError(
                f"Bad response from {self.host}: {text[:200]}"
            ) from err

    @staticmethod
    def _parse_challenge(message: str) -> dict[str, Any]:
        try:
            return json.loads(message)
        except json.JSONDecodeError as err:
            raise ShellyConnectionError(f"Malformed auth challenge: {message}") from err

    def _build_auth_block(self) -> dict[str, Any]:
        ctx = self._auth_ctx
        assert ctx is not None
        realm = ctx["realm"]
        nonce = ctx["nonce"]
        nc = ctx.get("nc", 1)
        cnonce = random.randint(0, 2**31 - 1)
        algorithm = ctx.get("algorithm", "SHA-256")

        ha1 = _sha256(f"{self._username}:{realm}:{self._password}")
        ha2 = _sha256("dummy_method:dummy_uri")
        nc_str = f"{nc:08x}"
        response = _sha256(f"{ha1}:{nonce}:{nc_str}:{cnonce}:auth:{ha2}")

        ctx["nc"] = nc + 1

        return {
            "realm": realm,
            "username": self._username,
            "nonce": nonce,
            "cnonce": cnonce,
            "response": response,
            "algorithm": algorithm,
        }


# --- High-level device operations, one function per RPC method used -------


async def get_device_info(client: ShellyRpcClient) -> dict[str, Any]:
    """Shelly.GetDeviceInfo is always exempt from auth."""
    return await client.call("Shelly.GetDeviceInfo")


async def get_sys_config(client: ShellyRpcClient) -> dict[str, Any]:
    return await client.call("Sys.GetConfig")


async def get_cloud_config(client: ShellyRpcClient) -> dict[str, Any]:
    return await client.call("Cloud.GetConfig")


async def get_mqtt_config(client: ShellyRpcClient) -> dict[str, Any]:
    return await client.call("MQTT.GetConfig")


async def get_ble_config(client: ShellyRpcClient) -> dict[str, Any]:
    return await client.call("BLE.GetConfig")


async def set_sys_config(client: ShellyRpcClient, config: dict[str, Any]) -> Any:
    return await client.call("Sys.SetConfig", {"config": config})


async def set_cloud_config(client: ShellyRpcClient, enable: bool) -> Any:
    return await client.call("Cloud.SetConfig", {"config": {"enable": enable}})


async def set_mqtt_config(client: ShellyRpcClient, enable: bool) -> Any:
    return await client.call("MQTT.SetConfig", {"config": {"enable": enable}})


async def set_ble_config(client: ShellyRpcClient, enable: bool) -> Any:
    return await client.call("BLE.SetConfig", {"config": {"enable": enable}})


async def reboot(client: ShellyRpcClient) -> Any:
    return await client.call("Shelly.Reboot")


async def check_for_update(client: ShellyRpcClient) -> Any:
    return await client.call("Shelly.CheckForUpdate")


async def update_firmware(client: ShellyRpcClient, stage: str = "stable") -> Any:
    return await client.call("Shelly.Update", {"stage": stage})


async def list_schedules(client: ShellyRpcClient) -> Any:
    return await client.call("Schedule.List")


async def create_schedule(client: ShellyRpcClient, config: dict[str, Any]) -> Any:
    return await client.call("Schedule.Create", config)


async def delete_schedule(client: ShellyRpcClient, schedule_id: int) -> Any:
    return await client.call("Schedule.Delete", {"id": schedule_id})


async def zigbee_clear(client: ShellyRpcClient) -> Any:
    """Clear the device's Zigbee network state (leave/forget pairing).

    Gen3+ dual-protocol devices expose this as ``Shelly.ZigbeeClear`` rather
    than under the ``Zigbee.`` namespace; devices without Zigbee hardware
    will reject it with an RPC error.
    """
    return await client.call("Shelly.ZigbeeClear")
