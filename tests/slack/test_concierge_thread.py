"""A person's concierge conversation is one thread, whether it starts in the dashboard or the DM."""

from collections.abc import Mapping, Sequence
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import pytest
from langgraph_sdk.client import LangGraphClient

from agent.slack import dashboard_routes, dm
from agent.slack.client import lookup_slack_thread_id
from agent.slack.dm import CONCIERGE_TS
from agent.thread_ids import concierge_thread_id

_SESSION = {"sub": "ada", "email": "ada@example.com"}
_DM = "D0123ABCD"


class _Store:
    def __init__(self) -> None:
        self.items: dict[tuple[tuple[str, ...], str], dict[str, Any]] = {}

    async def get_item(self, namespace: Sequence[str], key: str) -> dict[str, Any] | None:
        value = self.items.get((tuple(namespace), key))
        return {"value": value} if value is not None else None

    async def put_item(self, namespace: Sequence[str], key: str, value: dict[str, Any]) -> None:
        self.items[(tuple(namespace), key)] = value


class _Threads:
    def __init__(self) -> None:
        self.metadata: dict[str, dict[str, Any]] = {}

    async def get(self, thread_id: str) -> dict[str, Any]:
        return {"thread_id": thread_id, "metadata": self.metadata[thread_id]}


class _LangGraph:
    def __init__(self) -> None:
        self.store = _Store()
        self.threads = _Threads()
        self.created: list[str] = []

    async def dm_thread(self) -> str | None:
        return await lookup_slack_thread_id(cast(LangGraphClient, self), _DM, CONCIERGE_TS)


@pytest.fixture
def langgraph(monkeypatch: pytest.MonkeyPatch) -> _LangGraph:
    client = _LangGraph()

    async def thread_exists(thread_id: str) -> bool:
        return thread_id in client.threads.metadata

    async def create_dashboard_thread_record(
        thread_id: str, *, login: str, visibility: str, title: str | None, **_: object
    ) -> Mapping[str, Any]:
        client.created.append(thread_id)
        client.threads.metadata[thread_id] = {
            "owner_login": login,
            "visibility": visibility,
            "title": title,
        }
        return {"thread_id": thread_id}

    monkeypatch.setattr(dm, "langgraph_client", lambda: client)
    monkeypatch.setattr(dashboard_routes, "langgraph_client", lambda: client)
    monkeypatch.setattr(dashboard_routes, "thread_exists", thread_exists)
    monkeypatch.setattr(
        dashboard_routes, "create_dashboard_thread_record", create_dashboard_thread_record
    )
    return client


def _person(monkeypatch: pytest.MonkeyPatch, *, slack_user_id: str = "") -> SimpleNamespace:
    person = SimpleNamespace(
        id=uuid4(),
        slack_user_id=slack_user_id,
        typed_preferences=SimpleNamespace(concierge_mode=True),
    )

    async def for_login(_provider: str, login: str) -> SimpleNamespace | None:
        return person if login == "ada" else None

    async def for_identity(_provider: str, external_id: str) -> SimpleNamespace | None:
        return person if person.slack_user_id and external_id == person.slack_user_id else None

    async def open_dm(slack_user_id: str) -> str | None:
        return _DM if slack_user_id == person.slack_user_id else None

    monkeypatch.setattr(dashboard_routes.User, "for_login", for_login)
    monkeypatch.setattr(dm.User, "for_identity", for_identity)
    monkeypatch.setattr(dm, "open_dm", open_dm)
    return person


async def test_the_dashboard_opens_a_concierge_thread_that_a_later_dm_continues(
    monkeypatch: pytest.MonkeyPatch, langgraph: _LangGraph
) -> None:
    person = _person(monkeypatch)

    assert await dashboard_routes.api_concierge(_SESSION) == dashboard_routes.ConciergeThread(
        thread_id=None
    )
    opened = await dashboard_routes.api_open_concierge(_SESSION)
    reopened = await dashboard_routes.api_open_concierge(_SESSION)

    own = concierge_thread_id(str(person.id))
    assert opened.thread_id == reopened.thread_id == own
    assert langgraph.created == [own]
    assert langgraph.threads.metadata[own] == {
        "owner_login": "ada",
        "visibility": "private",
        "title": "Concierge",
    }
    assert (await dashboard_routes.api_concierge(_SESSION)).thread_id == own

    person.slack_user_id = "U1"
    await dm.bind_concierge_dm_for_slack("U1", _DM)

    assert await langgraph.dm_thread() == own


async def test_a_dm_that_already_has_a_conversation_keeps_it(
    monkeypatch: pytest.MonkeyPatch, langgraph: _LangGraph
) -> None:
    _person(monkeypatch, slack_user_id="U1")
    await langgraph.store.put_item(
        ("slack_thread_map", _DM), CONCIERGE_TS, {"thread_id": "slack-thread"}
    )
    langgraph.threads.metadata["slack-thread"] = {"owner_login": "ada", "visibility": "private"}

    opened = await dashboard_routes.api_open_concierge(_SESSION)
    await dm.bind_concierge_dm_for_slack("U1", _DM)

    assert opened.thread_id == "slack-thread"
    assert langgraph.created == []
    assert await langgraph.dm_thread() == "slack-thread"
