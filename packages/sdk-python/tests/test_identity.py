from chobo import identity


def test_default_identity_is_missing():
    identity.clear_identity()
    got = identity.get_identity()
    assert got == {
        "user_id": None, "org_id": None, "project": None,
        "identity_source": "missing",
    }


def test_set_and_get_identity():
    identity.set_identity(user_id="t-1", org_id="s-9", project="ggb")
    got = identity.get_identity()
    assert got["user_id"] == "t-1"
    assert got["org_id"] == "s-9"
    assert got["project"] == "ggb"
    assert got["identity_source"] == "header"


def test_get_returns_a_copy():
    identity.set_identity(user_id="t-1")
    got = identity.get_identity()
    got["user_id"] = "mutated"
    assert identity.get_identity()["user_id"] == "t-1"


def test_clear_resets_to_missing():
    identity.set_identity(user_id="t-1")
    identity.clear_identity()
    assert identity.get_identity()["identity_source"] == "missing"
