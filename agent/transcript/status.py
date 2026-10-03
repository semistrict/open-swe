"""Which transcript threads are running, as thread summaries report it.

A transcript thread is running from the moment its message is accepted
(``turn.requested``) until its last open turn settles. LangGraph only reports
the thread busy once the queued run starts, so a summary that read LangGraph
alone would call a thread idle while its message is already on screen.
"""

import logging
from collections.abc import Collection

from sqlalchemy import ARRAY, Text, bindparam, text

from agent.database import postgres

logger = logging.getLogger(__name__)

_RUNNING_THREADS = text(
    "SELECT thread_id FROM thread WHERE thread_id = ANY(:thread_ids) AND status = 'running'"
).bindparams(bindparam("thread_ids", type_=ARRAY(Text)))


async def running_transcript_threads(thread_ids: Collection[str]) -> frozenset[str]:
    """The given threads whose transcript has an open turn, from one read.

    No Postgres, or a failed read, returns none: summaries then fall back to
    LangGraph's view rather than failing to load.
    """
    if not thread_ids or not postgres.configured():
        return frozenset()
    try:
        async with postgres.read_only_transaction() as conn:
            rows = await conn.execute(_RUNNING_THREADS, {"thread_ids": list(thread_ids)})
            return frozenset(rows.scalars().all())
    except Exception:
        logger.warning(
            "Transcript status read failed; thread summaries use LangGraph status",
            exc_info=True,
            extra={"thread_count": len(thread_ids)},
        )
        return frozenset()
