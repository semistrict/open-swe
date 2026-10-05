import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from blockbuster import BlockBuster
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableBinding
from langchain_openai.chat_models.codex import (  # noqa: PLC2701
    CHATGPT_CODEX_BASE_URL,
    _ChatOpenAICodex,
)
from pydantic import BaseModel

from agent.utils import model, openai_oauth


@contextmanager
def detect_blocking_calls() -> Iterator[None]:
    """Leak-proof ``blockbuster_ctx``: deactivates even when the body raises."""
    blockbuster = BlockBuster()
    blockbuster.activate()
    try:
        yield
    finally:
        blockbuster.deactivate()


@pytest.fixture(autouse=True)
def _clean_oauth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "OPEN_SWE_OPENAI_OAUTH_BROKER_URL",
        "OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN",
        "OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE",
        "OPENAI_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPEN_SWE_OPENAI_OAUTH_BROKER_URL", "http://127.0.0.1:3210/token")
    monkeypatch.setenv("OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN", "broker-secret")


def _configure_token_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = tmp_path / "chatgpt-auth.json"
    store.write_text(
        json.dumps(
            {
                "access_token": "stored-access",
                "refresh_token": "stored-refresh",
                "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                "account_id": "stored-account",
            }
        )
    )
    monkeypatch.setenv("OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE", str(store))


def test_oauth_model_uses_dedicated_account_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, Any] = {}

    def fake_model(model_name: str, **kwargs: Any) -> str:
        captured["model_name"] = model_name
        captured.update(kwargs)
        return "MODEL"

    with (
        patch.object(model, "build_openai_oauth_model", fake_model),
        detect_blocking_calls(),
    ):
        result = model.make_model("openai:gpt-5.6-sol", use_gateway=False, max_tokens=123)

    assert result == "MODEL"
    assert captured["model_name"] == "gpt-5.6-sol"
    assert "base_url" not in captured
    assert "max_tokens" not in captured


@pytest.mark.filterwarnings("ignore:.*experimental and unofficial.*:UserWarning")
def test_oauth_model_enforces_account_backend_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    result = openai_oauth.build_openai_oauth_model("gpt-5.6-sol")

    assert isinstance(result, _ChatOpenAICodex)
    assert str(result.openai_api_base).rstrip("/") == CHATGPT_CODEX_BASE_URL
    assert result.use_responses_api is True
    assert result.store is False
    assert result.streaming is True
    assert result.originator == "open_swe_desktop"


def test_oauth_rejects_non_loopback_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("OPEN_SWE_OPENAI_OAUTH_BROKER_URL", "https://example.com/token")
    assert openai_oauth.openai_oauth_available() is False


@pytest.mark.filterwarnings("ignore:.*experimental and unofficial.*:UserWarning")
async def test_token_provider_authenticates_to_broker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    requests: list[tuple[str, dict[str, str]]] = []
    payloads = iter(
        [
            {"access_token": "access-token-a", "account_id": "account-a"},
            {"access_token": "access-token-b", "account_id": "account-b"},
        ]
    )

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return next(payloads)

    class Client:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, url: str, *, headers: dict[str, str]):
            requests.append((url, headers))
            return Response()

    oauth_model = openai_oauth.build_openai_oauth_model("gpt-5.6-sol")
    monkeypatch.setattr(openai_oauth.httpx2, "AsyncClient", Client)
    provider = oauth_model.token_provider  # type: ignore[attr-defined]
    first_token = await provider.aget_token()
    second_token = await provider.aget_token()

    assert first_token.access_token == "access-token-a"
    assert first_token.account_id == "account-a"
    assert second_token.access_token == "access-token-b"
    assert second_token.account_id == "account-b"
    assert provider.get_access_token() == "access-token-b"
    assert requests == [
        (
            "http://127.0.0.1:3210/token",
            {"Authorization": "Bearer broker-secret"},
        ),
        (
            "http://127.0.0.1:3210/token",
            {"Authorization": "Bearer broker-secret"},
        ),
    ]

    payload = oauth_model._get_request_payload(  # type: ignore[attr-defined]
        [SystemMessage("agent instructions"), HumanMessage("hello")]
    )
    assert payload["instructions"] == "agent instructions"
    assert all(item.get("role") != "system" for item in payload["input"])


@pytest.mark.filterwarnings("ignore:.*experimental and unofficial.*:UserWarning")
async def test_token_file_supplies_credentials_without_a_broker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _configure_token_file(monkeypatch, tmp_path)

    oauth_model = model.make_model("openai:gpt-5.6-sol", use_gateway=False)
    with detect_blocking_calls():
        token = await oauth_model.token_provider.aget_token()  # type: ignore[attr-defined]

    assert isinstance(oauth_model, _ChatOpenAICodex)
    assert oauth_model.originator == "open_swe"
    assert token.access_token == "stored-access"
    assert token.account_id == "stored-account"


@pytest.mark.filterwarnings("ignore:.*experimental and unofficial.*:UserWarning")
def test_desktop_broker_takes_precedence_over_token_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE", str(tmp_path / "chatgpt-auth.json"))

    result = openai_oauth.build_openai_oauth_model("gpt-5.6-sol")

    assert result.originator == "open_swe_desktop"  # type: ignore[attr-defined]


@pytest.mark.filterwarnings("ignore:.*experimental and unofficial.*:UserWarning")
def test_structured_output_requests_a_tool_call(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Codex streams never carry `parsed`, so json_schema output fails to parse."""

    class Title(BaseModel):
        title: str

    _configure_token_file(monkeypatch, tmp_path)
    oauth_model = openai_oauth.build_openai_oauth_model("gpt-5.6-sol")

    binding = oauth_model.with_structured_output(Title).first  # type: ignore[attr-defined]
    assert isinstance(binding, RunnableBinding)
    payload = oauth_model._get_request_payload([HumanMessage("hi")], **binding.kwargs)  # type: ignore[attr-defined]

    assert [tool["name"] for tool in payload["tools"]] == ["Title"]
    assert "format" not in payload.get("text", {})
