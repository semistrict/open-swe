"""Ending endless responses when the process starts stopping, so it can drain.

A stopping server waits for every open response to finish. A stream that only
ends when its reader leaves — the transcript's live events, an event stream the
dev proxy forwards — holds a stopping worker open indefinitely: uvicorn's hot
reload never completes and a deploy waits out its kill timeout. ``install``
puts a handler in front of the server's own for the stop signals, and
``until_stopping`` ends a streamed body once one arrives; its reader reconnects
to whichever process serves next.
"""

import asyncio
import contextlib
import logging
import signal
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from types import FrameType

logger = logging.getLogger(__name__)

_STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM)

type _Handler = Callable[[int, FrameType | None], object] | int | signal.Handlers | None

_stopping: asyncio.Event | None = None


def install() -> None:
    """Note the stop signals before the server's handlers act on them.

    Called from the server's lifespan, on the running loop. The server's own
    handlers still run: this only adds the notice.
    """
    global _stopping
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    try:
        for signum in _STOP_SIGNALS:
            signal.signal(signum, _chained(signal.getsignal(signum), loop, stopping))
    except ValueError:
        # Signal handlers can only be set from the main thread; streams then end
        # when their readers leave, as before.
        logger.warning("Stop signals are not observable off the main thread")
        return
    _stopping = stopping


def _chained(
    previous: _Handler, loop: asyncio.AbstractEventLoop, stopping: asyncio.Event
) -> Callable[[int, FrameType | None], None]:
    def handle(signum: int, frame: FrameType | None) -> None:
        loop.call_soon_threadsafe(stopping.set)
        if callable(previous):
            previous(signum, frame)
        elif previous == signal.SIG_DFL:
            signal.signal(signum, signal.SIG_DFL)
            signal.raise_signal(signum)

    return handle


async def until_stopping[T](chunks: AsyncIterator[T]) -> AsyncGenerator[T]:
    """``chunks``, ending early once the process starts stopping."""
    stop = asyncio.ensure_future((_stopping or asyncio.Event()).wait())
    try:
        while True:
            step = asyncio.ensure_future(anext(chunks))
            done, _ = await asyncio.wait({step, stop}, return_when=asyncio.FIRST_COMPLETED)
            if step not in done:
                step.cancel()
                with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                    await step
                return
            try:
                chunk = step.result()
            except StopAsyncIteration:
                return
            yield chunk
    finally:
        stop.cancel()
        if isinstance(chunks, AsyncGenerator):
            await chunks.aclose()
