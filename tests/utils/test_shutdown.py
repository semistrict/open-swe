import asyncio
import signal
from collections.abc import AsyncGenerator
from types import FrameType

import pytest

from agent.utils import shutdown


async def test_a_stop_signal_ends_an_endless_stream_and_still_reaches_the_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server_saw: list[int] = []

    def server_handler(signum: int, frame: FrameType | None) -> None:
        server_saw.append(signum)

    previous_int = signal.getsignal(signal.SIGINT)
    previous = signal.signal(signal.SIGTERM, server_handler)
    monkeypatch.setattr(shutdown, "_stopping", None)
    cleaned_up = asyncio.Event()

    async def endless() -> AsyncGenerator[str]:
        try:
            while True:
                yield ": ping\n\n"
                await asyncio.sleep(3600)
        finally:
            cleaned_up.set()

    try:
        shutdown.install()
        chunks = shutdown.until_stopping(endless())
        assert await anext(chunks) == ": ping\n\n"
        signal.raise_signal(signal.SIGTERM)

        remaining = [chunk async for chunk in chunks]
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous)

    assert remaining == []
    assert cleaned_up.is_set()
    assert server_saw == [signal.SIGTERM]
