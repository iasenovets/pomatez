# Automatic session history export

**TODO: Open a follow-up upstream feature PR for automatic JSONL export
after [PR #755](https://github.com/zidoro/pomatez/pull/755) is accepted
and merged.** Keep this work on
`iasenovets:feat/automatic-session-history-export` until then. The branch
starts from `601b0bd49201324f226e4fc2ae6752e884f3a21b` and depends on the
session history IndexedDB repository, the Statistics interface, and the
versioned JSONL serializer introduced by that PR. Once merged, fetch
upstream `master`, rebase the follow-up commits onto its merged
implementation, resolve conflicts, rerun platform validation, recheck
contribution rules, and open a separate PR referencing #755.

## Using automatic export

In Statistics, choose a local export folder, set an interval of 5, 15,
or 60 minutes, and enable automatic export. It is off by default. The
app checks immediately when enabled and on restart, then checks at the
selected interval while the renderer is running. Folder selection can
be cancelled without changing the current folder. The app needs write
permission and a destination filesystem that supports hard links.
Existing exports are left in place when settings change or exports
are disabled.

Each file is an immutable snapshot for a UTC calendar day. Manual
exports keep the selected reporting timezone. Automatic exports use
the same versioned JSONL schema, including session context and
coverage gaps. Credited durations remain tied to their stored segment
boundaries. Days with new or recovered history get a new snapshot.
Stable filenames are derived from the SHA-256 of the exact UTF-8
payload. A repeat with identical content leaves the existing file in
place. A conflicting file is preserved and reported as an error.

A collector should use the UTC period in the export header and upsert
events by `(device_id, event_id)`. Changed snapshots and midnight
context can repeat event IDs across files. Coverage records can be
deduplicated by `(device_id, session_id, from_at, to_at, reason)`.
Summing each file independently would double-count shared events.
The destination can be an ordinary synchronized local folder. There
is no synchronizer or network integration in Pomatez.

The native writers stage the payload in the destination, flush it,
then publish it without replacing an existing file. Read only final
`pomatez-auto-*.jsonl` files. A hard kill can leave a hidden partial
file. Such files are ignored and may be removed after Pomatez stops.
A failed write does not advance the last successful snapshot. The app
retries on a later check and checks the native destination again after
restart. Sleep, suspended webviews, or a closed app can delay checks.
Very large daily snapshots above 32 MiB are reported as errors and can
be investigated from Statistics without modifying history.

## Validation

- Node 24 session history suite covers scheduling all three intervals,
  cancellation and overlapping checks, UTC-midnight coverage, restart,
  retry, file collision protection, and interrupted writes.
- The packaged Linux Electron 34.5.8 app ran under Xvfb with an isolated
  profile. The native chooser preserved disabled state on cancellation,
  accepted a folder, and persisted the grant. A timed focus segment
  exported while the normal minimize-to-tray handler kept the window
  hidden. The test shortened only the selected export interval from
  five minutes to 1.5 seconds so it could observe successive ticks.
  Filename hash and JSONL content were independently verified. Relaunch
  kept preferences and reused the file. Relaunch with a removed
  destination showed an error.
- Three standalone Rust tests passed against the Tauri filesystem
  helpers. Native Cargo compilation is blocked by missing GLib/GObject
  development metadata. Native Tauri folder selection, export, tray
  cadence and restart remain untested. Native Windows and macOS also
  remain untested.
- To verify on a desktop, enable five-minute export using a disposable
  profile and folder, record and pause focus, minimize to tray, and wait
  for the next tick. Check the JSONL header and filename hash, relaunch
  with the same profile, and confirm that the file is reused. Then
  make the destination unavailable, record another segment, and verify
  the failure appears in Statistics. Restore the folder and confirm that
  a later check publishes the new snapshot.
