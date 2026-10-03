"""Bot DMs, optionally run in concierge mode: one conversation instead of a thread per message.

Off unless the person turns on ``concierge_mode`` in their own preferences. When
it is on, the conversation is keyed with the same non-message timestamp code
channels and incident channels use, so replies post into the DM instead of
opening a thread and the channel's own history is the conversation transcript. That
timestamp is also how the rest of the code recognizes the mode: only a DM the
owner enabled ever reaches a run with it.
"""

import logging
from typing import Any

from langchain_core.messages import AIMessage

from agent.slack.client import (
    SlackThreadMappingError,
    bind_slack_thread_id,
    lookup_slack_thread_id,
    post_slack_top_level_message_with_ts,
)
from agent.slack.http import SLACK_REQUEST_ERRORS, SlackClient, slack_error
from agent.slack.payloads import SlackChannelContext
from agent.thread_ids import concierge_thread_id
from agent.users import User
from agent.utils.thread_ops import langgraph_client, queue_message_for_thread

logger = logging.getLogger(__name__)

CONCIERGE_TS = "0"
CONCIERGE_TITLE = "Concierge"


def is_dm_channel(channel_context: SlackChannelContext | None) -> bool:
    """Whether Slack reports this channel as a direct message with the bot."""
    return channel_context is not None and channel_context.is_im is True


def is_concierge_thread(channel_context: SlackChannelContext | None, thread_ts: str) -> bool:
    """Whether this location is a DM running in concierge mode."""
    return is_dm_channel(channel_context) and thread_ts == CONCIERGE_TS


def dm_thread_title(name: str) -> str:
    """The fixed name of a person's DM thread, or "" until Slack tells us who they are.

    An empty title leaves the thread unnamed rather than naming it after one
    request, so the next message can still name it for the person.
    """
    return f"DMs between Open SWE and {name.strip()}" if name.strip() else ""


async def bind_concierge_dm(user: User, dm_channel_id: str) -> str:
    """The thread a person's concierge DM continues, binding a new DM to their concierge thread.

    A DM that already has a conversation keeps it. Otherwise it continues the thread
    the dashboard opens for the person, so both surfaces share one conversation.
    """
    client = langgraph_client()
    existing = await lookup_slack_thread_id(client, dm_channel_id, CONCIERGE_TS)
    if existing:
        return existing
    own = concierge_thread_id(str(user.id))
    try:
        return await bind_slack_thread_id(client, dm_channel_id, CONCIERGE_TS, own)
    except SlackThreadMappingError:
        # Another event bound the DM first; its thread stands.
        existing = await lookup_slack_thread_id(client, dm_channel_id, CONCIERGE_TS)
        if existing:
            return existing
        raise


async def bind_concierge_dm_for_slack(slack_user_id: str, dm_channel_id: str) -> None:
    """Bind a concierge DM to its owner's concierge thread before the message is routed."""
    user = await User.for_identity("slack", slack_user_id)
    if user is not None:
        await bind_concierge_dm(user, dm_channel_id)


async def concierge_dm_channel(user: User) -> str | None:
    """The person's DM with the bot, when they linked Slack and Slack can open it."""
    return await open_dm(user.slack_user_id) if user.slack_user_id else None


async def note_for_concierge(slack_user_id: str, dm_channel_id: str, note: str) -> None:
    """Queue ``note`` for the person's concierge thread, which skips the bot's own DM posts."""
    if not await User.concierge_mode_for_slack(slack_user_id):
        return
    thread_id = await lookup_slack_thread_id(langgraph_client(), dm_channel_id, CONCIERGE_TS)
    if thread_id is None:
        return
    if not await queue_message_for_thread(thread_id, [{"type": "text", "text": note}]):
        logger.warning(
            "Could not queue a note for the concierge thread",
            extra={"slack_user_id": slack_user_id, "agent_thread_id": thread_id},
        )


async def open_dm(slack_user_id: str) -> str | None:
    try:
        async with SlackClient.bot() as client:
            response = await client.conversations_open(users=slack_user_id)
    except SLACK_REQUEST_ERRORS as exc:
        logger.warning(
            "Slack DM could not be opened",
            extra={"slack_user": slack_user_id, "slack_error": slack_error(exc)},
        )
        return None
    channel = response.get("channel")
    channel_id = channel.get("id") if isinstance(channel, dict) else None
    return channel_id if isinstance(channel_id, str) and channel_id else None


async def _record_in_concierge_thread(channel_id: str, text: str) -> None:
    """Add a message the bot sent to the person's concierge conversation, so a reply has context."""
    client = langgraph_client()
    thread_id = await lookup_slack_thread_id(client, channel_id, CONCIERGE_TS)
    if thread_id is None:
        return
    try:
        thread = await client.threads.get(thread_id)
        if thread.get("status") == "busy":
            logger.info("Concierge thread is busy; DM not recorded", extra={"thread_id": thread_id})
            return
        await client.threads.update_state(thread_id, values={"messages": [AIMessage(content=text)]})
    except Exception:
        logger.warning(
            "Could not record a DM in the concierge thread",
            extra={"thread_id": thread_id},
            exc_info=True,
        )


async def send_dm_with_location(
    slack_user_id: str, text: str, *, blocks: list[dict[str, Any]] | None = None
) -> tuple[str, str] | None:
    """DM a person as the bot; in concierge mode the message joins their one DM conversation."""
    channel_id = await open_dm(slack_user_id)
    if channel_id is None:
        return None
    message_ts, error = await post_slack_top_level_message_with_ts(
        channel_id, text, unfurl_links=False, unfurl_media=False, blocks=blocks
    )
    if message_ts is None:
        logger.warning(
            "Slack DM could not be posted",
            extra={"slack_user": slack_user_id, "slack_error": error},
        )
        return None
    if await User.concierge_mode_for_slack(slack_user_id):
        await _record_in_concierge_thread(channel_id, text)
    return channel_id, message_ts


async def send_dm(
    slack_user_id: str, text: str, *, blocks: list[dict[str, Any]] | None = None
) -> bool:
    """Send a DM and record it in the concierge conversation."""
    return await send_dm_with_location(slack_user_id, text, blocks=blocks) is not None
