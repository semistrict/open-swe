from datetime import UTC, datetime, timedelta
from functools import partialmethod
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx2
from langchain_core.language_models import BaseChatModel
from langchain_openai.chat_models.codex import _ChatOpenAICodex  # noqa: PLC2701
from langchain_openai.chatgpt_oauth import (
    _ChatGPTOAuthTokenProvider,  # noqa: PLC2701
    _ChatGPTToken,  # noqa: PLC2701
    _FileChatGPTOAuthTokenProvider,  # noqa: PLC2701
)

from agent.config import ENV

_BROKER_MANAGED_REFRESH_TOKEN = "managed-by-desktop-broker"


class _ChatGPTCodexModel(_ChatOpenAICodex):
    # Streamed Codex responses never carry the `parsed` field the json_schema default
    # reads, so structured output (thread titles, branch names) goes through a tool call.
    with_structured_output = partialmethod(
        _ChatOpenAICodex.with_structured_output, method="function_calling"
    )


def _broker_config() -> tuple[str, str] | None:
    url = ENV.OPEN_SWE_OPENAI_OAUTH_BROKER_URL.get()
    token = ENV.OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN.get()
    if not url or not token:
        return None
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path != "/token":
        return None
    return url, token


def _token_file() -> Path | None:
    raw = ENV.OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE.optional()
    return Path(raw).expanduser() if raw else None


def openai_oauth_available() -> bool:
    """Whether OpenAI models run on a ChatGPT subscription instead of an API key."""
    return _broker_config() is not None or _token_file() is not None


class _DesktopOpenAIOAuthTokenProvider(_ChatGPTOAuthTokenProvider):
    def __init__(self, broker_url: str, broker_token: str) -> None:
        self._broker_url = broker_url
        self._broker_token = broker_token
        self._current_token: _ChatGPTToken | None = None

    def get_token(self) -> _ChatGPTToken:
        if self._current_token is None:
            raise RuntimeError("Local OpenAI credentials have not been fetched asynchronously")
        return self._current_token

    async def aget_token(self) -> _ChatGPTToken:
        async with httpx2.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                self._broker_url,
                headers={"Authorization": f"Bearer {self._broker_token}"},
            )
        response.raise_for_status()
        payload = response.json()
        access_token = payload.get("access_token") if isinstance(payload, dict) else None
        account_id = payload.get("account_id") if isinstance(payload, dict) else None
        if not isinstance(access_token, str) or not access_token:
            raise ValueError("Local OpenAI credential broker returned no access token")
        if (
            not isinstance(account_id, str)
            or not account_id
            or len(account_id) > 512
            or "\r" in account_id
            or "\n" in account_id
        ):
            raise ValueError("Local OpenAI credential broker returned no account ID")
        token = _ChatGPTToken(
            access_token=access_token,
            refresh_token=_BROKER_MANAGED_REFRESH_TOKEN,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            account_id=account_id,
        )
        self._current_token = token
        return token

    def get_access_token(self) -> str:
        return self.get_token().access_token

    async def aget_access_token(self) -> str:
        return (await self.aget_token()).access_token


def build_openai_oauth_model(model_name: str, **kwargs: Any) -> BaseChatModel:
    """Build a Codex model on ChatGPT OAuth, preferring the desktop app's broker.

    Without a broker, tokens come from a langchain-openai token store, the format
    Deep Agents Code also signs in to, refreshed in place under its file lock.
    """
    broker = _broker_config()
    if broker is not None:
        return _ChatGPTCodexModel(
            model=model_name,
            token_provider=_DesktopOpenAIOAuthTokenProvider(*broker),
            originator="open_swe_desktop",
            **kwargs,
        )
    token_file = _token_file()
    if token_file is None:
        raise ValueError("ChatGPT OAuth credentials are unavailable")
    return _ChatGPTCodexModel(
        model=model_name,
        token_provider=_FileChatGPTOAuthTokenProvider(path=token_file),
        originator="open_swe",
        **kwargs,
    )
