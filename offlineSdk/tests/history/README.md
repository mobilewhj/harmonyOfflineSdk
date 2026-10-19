# Preserved historical contract tests

`test_managed_030.cjs` is preserved byte for byte from the previous unpublished
managed implementation. SHA-256:
`f7fded1d3f299739578cee5082cb51c27420c589b49410d2dd9e7490cc54ff40`.

It exercises the old Preferences active/history/enabled/cacheDirty harness,
runtime active replacement and permanent failed-version policy. Those facts
are superseded by the current transactional lifecycle contract. It is not a
current SDK regression target. To reproduce historical results, use the complete
matching source snapshot and restore this file to its original test directory;
its original relative paths are intentionally not changed here.

Current lifecycle and boundary regressions are in the parent directory.
Valid cancellation, owner/waiter, page, timing, readiness and resource ownership
coverage was reviewed and ported separately; equal test counts are not evidence
of semantic equivalence. This historical preservation does not change the
ordinary current test glob or suppress any assertion in a current test file.
