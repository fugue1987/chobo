import chobo


def test_public_surface_present():
    for name in ["init", "set_identity", "get_identity", "clear_identity",
                 "meter", "flush", "shutdown", "get_stats", "extractors"]:
        assert hasattr(chobo, name), f"missing public symbol: {name}"


def test_version_string():
    assert isinstance(chobo.__version__, str)
    assert chobo.__version__ == "0.1.3"


def test_flush_and_shutdown_safe_before_init():
    # Calling lifecycle helpers before init() must not raise.
    import chobo._runtime as rt
    rt.reset()
    assert chobo.flush(timeout=0.1) is True
    chobo.shutdown(timeout=0.1)
    assert chobo.get_stats() == {}
