<%! import json %>"""${message}"""

from alembic import op

revision = "${up_revision}"
down_revision = ${json.dumps(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    # A hot-reloading dev server applies a new migration as soon as it is
    # written; failing until this is filled in keeps it from recording an empty one.
    ${upgrades if upgrades else 'raise NotImplementedError("write this migration")'}


def downgrade() -> None:
    raise NotImplementedError
