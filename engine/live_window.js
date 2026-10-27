/** Resolve the bounded live playlist window without changing the legacy default. */
function resolveLivePlaylistDuration(seconds = 60) {
  if (!Number.isFinite(seconds) || seconds < 6 || seconds > 120) {
    throw new RangeError("livePlaylistDurationSeconds must be a finite number between 6 and 120");
  }
  return seconds;
}

module.exports = { resolveLivePlaylistDuration };
