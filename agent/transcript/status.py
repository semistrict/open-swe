"""What the transcript says a thread is doing, as thread summaries report it.

A transcript thread is running from the moment its message is accepted
(``turn.requested``) until its last open turn settles. LangGraph only reports
the thread busy once the queued run starts, so a summary that read LangGraph
alone would call a thread idle while its message is already on screen. When its
last turn ended is what lets a watcher see a run finish even if it never caught
the run in progress.
"""

import logging
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ARRAY, Text, bindparam, text

from agent.database import postgres

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TranscriptActivity:
    running: bool
    last_turn_ended_at: datetime | None


_ACTIVITY = text(
    """
    SELECT thread.thread_id, thread.status = 'running' AS running,
        (
            SELECT max(turn.completed_at) FROM thread_turn AS turn
            WHERE turn.thread_id = thread.thread_id
        ) AS last_turn_ended_at
    FROM thread
    WHERE thread.thread_id = ANY(:thread_ids)
    """
).bindparams(bindparam("thread_ids", type_=ARRAY(Text)))


async def transcript_activity(thread_ids: Collection[str]) -> Mapping[str, TranscriptActivity]:
    """The given threads' transcript activity, from one read; threads without one are absent.

    No Postgres, or a failed read, returns none: summaries then fall back to
    LangGraph's view rather than failing to load.
    """
    if not thread_ids or not postgres.configured():
        return {}
    try:
        async with postgres.read_only_transaction() as conn:
            rows = (await conn.execute(_ACTIVITY, {"thread_ids": list(thread_ids)})).mappings()
            return {
                row["thread_id"]: TranscriptActivity(
                    running=row["running"], last_turn_ended_at=row["last_turn_ended_at"]
                )
                for row in rows
            }
    except Exception:
        logger.warning(
            "Transcript status read failed; thread summaries use LangGraph status",
            exc_info=True,
            extra={"thread_count": len(thread_ids)},
        )
        return {}
