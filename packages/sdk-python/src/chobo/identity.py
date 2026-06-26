"""Process-local identity context. Set once at the request boundary, read at capture time."""
import contextvars

_identity = contextvars.ContextVar("chobo_identity", default=None)


def set_identity(user_id=None, org_id=None, project=None, source="header"):
    _identity.set({
        "user_id": user_id,
        "org_id": org_id,
        "project": project,
        "identity_source": source,
    })


def get_identity():
    val = _identity.get()
    if val is None:
        return {
            "user_id": None, "org_id": None, "project": None,
            "identity_source": "missing",
        }
    return dict(val)


def clear_identity():
    _identity.set(None)
