# Executed strict twenty-second recovery probe

At source `fd3e127809f9091453041ccbd1eb9c56d5e9cf39`, the snapshot before any HTTP wait still contained a live Pi run after twenty seconds. The runner assertion failed; alarm-only completion did not pass. PiHarness defaults to a thirty-second heartbeat. The later fixture probes a forty-five-second window using the unchanged public wrapper scheduling.

The earlier source `6bb3dd2d17350da7a8057903ad29fac665c0fd48` used blocking HTTP waits after twenty seconds and could not prove alarm-only completion. Its development results are not current qualification evidence and must not be reused as an alarm-only PASS.
