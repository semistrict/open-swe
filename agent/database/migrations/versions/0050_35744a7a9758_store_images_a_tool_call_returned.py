"""Store images a tool call returned"""

from alembic import op

revision = "35744a7a9758"
down_revision = ["1a27b64154a3", "243390dbd39e", "f7b59c5091a8", "52fab62a7608"]
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The images a tool returned (a read of a PNG, say), as attachment references
    # like a message's: the bytes live in thread_attachment, keyed by the call.
    op.execute("ALTER TABLE thread_tool_call ADD COLUMN attachments jsonb")


def downgrade() -> None:
    raise NotImplementedError
