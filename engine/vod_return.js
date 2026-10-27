const assert = require('node:assert/strict');

const mediaTail = rows => rows?.filter(row => row.uri && Number.isFinite(row.duration) && row.duration > 0).slice(-1)[0];

/**
 * Retain the earliest regenerated muxed window ending at the exported live tail.
 * Return the counters removed from the generated arrays for the Session offsets.
 */
function alignReturnVod(vod, transition) {
  assert.equal(Object.keys(vod.audioSegments || {}).length, 0, 'live return preservation supports muxed audio only');
  assert.ok(!vod.skipSerializeMediaSequences, 'live return preservation requires full serialization');
  const bandwidths = Object.keys(transition || {});
  const vodBandwidths = Object.keys(vod.segments);
  assert.ok(bandwidths.length > 0 && bandwidths.length === vodBandwidths.length &&
    vodBandwidths.every(bw => bandwidths.includes(bw)), 'exported live tail renditions must match the VOD');
  const tails = Object.fromEntries(bandwidths.map(bw => [bw, mediaTail(transition[bw])]));
  assert.ok(bandwidths.every(bw => tails[bw] && Number.isFinite(tails[bw].timelinePosition)),
    'every exported live tail requires a finite programme timestamp');
  const ends = bandwidths.map(bw => tails[bw].timelinePosition + tails[bw].duration * 1000);
  assert.ok(ends.every(end => Number.isFinite(end) && end === ends[0]), 'exported live tail rendition ends disagree');

  const index = vod.mediaSequences.findIndex(sequence => bandwidths.every(bw => {
    const tail = mediaTail(sequence.segments[bw]);
    return tail && tail.uri === tails[bw].uri && tail.timelinePosition === tails[bw].timelinePosition &&
      tail.byteRange === tails[bw].byteRange && tail.duration === tails[bw].duration;
  }));
  assert.ok(index >= 0, 'no regenerated return window preserves the exported live tail');
  const sequenceOffset = vod.mediaSequenceValues[index];
  const discontinuityOffset = vod.discontinuities[index];
  const position = vod.deltaTimes[index]?.position;
  assert.ok(Number.isSafeInteger(sequenceOffset) && sequenceOffset >= 0 &&
    Number.isSafeInteger(discontinuityOffset) && discontinuityOffset >= 0, 'invalid live return counter offsets');
  assert.ok(Number.isFinite(position), 'invalid live return playhead clock');

  // Validate all retained metadata before mutating any generated arrays.
  const sequences = vod.mediaSequences.slice(index);
  for (let i = index; i < vod.mediaSequences.length; i++) {
    assert.ok(Number.isSafeInteger(vod.mediaSequenceValues[i]) && vod.mediaSequenceValues[i] >= sequenceOffset &&
      Number.isSafeInteger(vod.discontinuities[i]) && vod.discontinuities[i] >= discontinuityOffset,
      'invalid live return generated counters');
    assert.ok(Number.isFinite(vod.deltaTimes[i]?.position) && vod.deltaTimes[i].position >= position &&
      Number.isFinite(vod.deltaTimes[i].interval), 'invalid live return playhead clock');
  }
  const shift = (values, offset) => Object.fromEntries(sequences.map((_, i) => [i, values[i + index] - offset]));
  vod.mediaSequenceValues = shift(vod.mediaSequenceValues, sequenceOffset);
  vod.discontinuities = shift(vod.discontinuities, discontinuityOffset);
  vod.deltaTimes = vod.deltaTimes.slice(index).map((row, i) => ({ position: row.position - position, interval: i ? row.interval : 0 }));
  vod.mediaSequences = sequences;
  vod.videoSequencesCount = sequences.length;
  return { sequenceOffset, discontinuityOffset };
}

module.exports = { alignReturnVod };
