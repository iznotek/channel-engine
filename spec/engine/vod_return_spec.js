const { Readable } = require('stream');
const HLSVod = require('@eyevinn/hls-vodtolive');
const Session = require('../../engine/session.js');
const { SessionStateStore, SessionState } = require('../../engine/session_state.js');
const { PlayheadStateStore } = require('../../engine/playhead_state.js');

const bandwidths = ['1200', '2400', '4800'];
const clone = value => JSON.parse(JSON.stringify(value));
const tail = rows => rows.filter(row => row.uri && row.duration > 0).slice(-1)[0];
const align = (vod, transition) => require('../../engine/vod_return.js').alignReturnVod(vod, transition);

function liveTransition() {
  return Object.fromEntries(bandwidths.map(bw => [bw, [
    { discontinuity: true },
    ...Array.from({ length: 32 }, (_, i) => ({
      uri: `https://fixture.invalid/live/${bw}/${i}.ts`, duration: 2,
      timelinePosition: 1000000 + i * 2000, byteRange: '100@0',
    })),
    { discontinuity: true, cue: { in: true } },
  ]]));
}

async function sourceVod(alwaysNewSegments = false) {
  const vod = new HLSVod('https://fixture.invalid/vod/master.m3u8', [], 500000, null, null, { calculatePDT: true, sequenceAlwaysContainNewSegments: alwaysNewSegments });
  vod.SEQUENCE_DURATION = 60;
  const segmentDuration = alwaysNewSegments ? 2 : 6;
  await vod.load(
    () => Readable.from(['#EXTM3U\n' + bandwidths.map(bw => `#EXT-X-STREAM-INF:BANDWIDTH=${bw}\n${bw}.m3u8\n`).join('')]),
    bw => Readable.from([`#EXTM3U\n#EXT-X-TARGETDURATION:${segmentDuration}\n` + Array.from({ length: alwaysNewSegments ? 90 : 30 }, (_, i) =>
      (i === 5 ? '#EXT-X-DISCONTINUITY\n' : '') + `#EXTINF:${segmentDuration},\n${bw}/${i}.ts\n`
    ).join('') + '#EXT-X-ENDLIST\n'])
  );
  return vod;
}

async function reloadedVod(alwaysNewSegments = false) {
  const vod = await sourceVod(alwaysNewSegments);
  const transition = liveTransition();
  await vod.reload(3, transition, null, false);
  return { vod, transition };
}

async function reloadSession(options = {}, reloadBehind = false) {
  const store = {
    sessionStateStore: new SessionStateStore(), playheadStateStore: new PlayheadStateStore(),
    instanceId: 'return-test',
  };
  const session = new Session({}, { sessionId: 'return-test', ...options }, store);
  await session.initAsync();
  const vod = await sourceVod(options.alwaysNewSegments);
  await session._sessionState.setCurrentVod(vod, { ttl: 60000 });
  await session._sessionState.set('state', SessionState.VOD_RELOAD_INIT);
  await session._playheadState.set('vodMediaSeqVideo', 2, true);
  const transition = liveTransition();
  session.switchDataForSession = {
    mediaSeq: 100, discSeq: 7, mediaSeqOffset: 32, reloadBehind,
    transitionSegments: transition, transitionAudioSegments: null,
  };
  await session._tickAsync();
  return { session, vod, transition };
}

describe('Live return VOD alignment', () => {
  it('chooses the earliest window with the exported tail in every rendition and rebases counters and clocks', async () => {
    const { vod, transition } = await reloadedVod();
    const retained = vod.mediaSequences[3];
    const originalIntervals = vod.getDeltaTimes().slice(3);
    const originalPositions = vod.getPlayheadPositions().slice(3);
    expect(align(vod, transition)).toEqual({ sequenceOffset: 3, discontinuityOffset: 1 });
    expect(vod.mediaSequences[0]).toBe(retained);
    expect(vod.getLiveMediaSequencesCount()).toEqual(vod.mediaSequences.length);
    expect(vod.mediaSequenceValues[0]).toEqual(0);
    expect(vod.discontinuities[0]).toEqual(0);
    expect(vod.getPlayheadPositions()).toEqual(originalPositions.map(position => position - originalPositions[0]));
    expect(vod.getDeltaTimes()).toEqual(originalIntervals.map((interval, i) => i === 0 ? 0 : interval));
    bandwidths.forEach(bw => expect(tail(vod.getLiveMediaSequenceSegments(0)[bw])).toEqual(tail(transition[bw])));
  });

  it('uses generated counter values rather than the selected array index', async () => {
    const { vod, transition } = await reloadedVod();
    Object.keys(vod.mediaSequenceValues).forEach(key => { vod.mediaSequenceValues[key] = 10 + 2 * Number(key); });
    Object.keys(vod.discontinuities).forEach(key => { vod.discontinuities[key] += 4; });
    expect(align(vod, transition)).toEqual({ sequenceOffset: 16, discontinuityOffset: 5 });
    expect(vod.mediaSequenceValues[1]).toEqual(2);
    expect(vod.discontinuities[0]).toEqual(0);
  });

  it('rejects rendition end disagreement even when each exported identity matches', async () => {
    const { vod, transition } = await reloadedVod();
    tail(transition['2400']).duration += 1;
    // Regenerated windows share these segment objects with the exported transition.
    expect(() => align(vod, transition)).toThrowError(/end/);
  });

  it('preserves the exported tail and two-second progression with always-new windows', async () => {
    const { session, vod, transition } = await reloadSession({ preserveLiveReturnTail: true, alwaysNewSegments: true });
    bandwidths.forEach(bw => expect(tail(vod.getLiveMediaSequenceSegments(0)[bw])).toEqual(tail(transition[bw])));
    expect(vod.getPlayheadPositions().slice(0, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(await session._getCurrentPlayheadPosition()).toEqual(0);
  });

  for (const field of ['uri', 'timelinePosition', 'byteRange', 'duration']) {
    it(`rejects a tail with mismatched ${field} without mutating the VOD`, async () => {
      const { vod, transition } = await reloadedVod();
      const changed = clone(transition);
      const last = tail(changed['2400']);
      last[field] = typeof last[field] === 'number' ? last[field] + 1 : last[field] + '-changed';
      const before = vod.toJSON();
      expect(() => align(vod, changed)).toThrowError(/tail|end/);
      expect(vod.toJSON()).toEqual(before);
    });
  }

  it('rejects a missing rendition and empty or disagreeing exported tails', async () => {
    const { vod, transition } = await reloadedVod();
    const missing = clone(transition);
    delete missing['2400'];
    expect(() => align(vod, missing)).toThrowError(/rendition/);
    expect(() => align(vod, {})).toThrowError(/tail|rendition/);
    transition['2400'] = [{ discontinuity: true }];
    expect(() => align(vod, transition)).toThrowError(/tail/);
  });

  for (const invalid of ['mediaSequenceValues', 'discontinuities', 'deltaTimes']) {
    it(`rejects invalid ${invalid} before changing any generated arrays`, async () => {
      const { vod, transition } = await reloadedVod();
      vod[invalid][3] = invalid === 'deltaTimes' ? { position: NaN, interval: 0 } : -1;
      const sequences = vod.mediaSequences;
      expect(() => align(vod, transition)).toThrowError(/offset|counter|clock/);
      expect(vod.mediaSequences).toBe(sequences);
    });
  }

  it('rejects demuxed audio in the alignment helper', async () => {
    const { vod, transition } = await reloadedVod();
    vod.audioSegments = { audio: { en: [] } };
    expect(() => align(vod, transition)).toThrowError(/muxed/);
  });

  it('applies alignment at the actual Session reload boundary and resets the playhead to the retained window', async () => {
    const { session, vod, transition } = await reloadSession({ preserveLiveReturnTail: true });
    expect(await session._sessionState.get('mediaSeq')).toEqual(103);
    expect(await session._playheadState.get('mediaSeq')).toEqual(103);
    expect(await session._sessionState.get('discSeq')).toEqual(8);
    expect(await session._sessionState.get('vodMediaSeqVideo')).toEqual(0);
    expect(await session._playheadState.get('vodMediaSeqVideo')).toEqual(0);
    expect(await session._getCurrentPlayheadPosition()).toEqual(0);
    expect(await session._getCurrentDeltaTime()).toEqual(0);
    expect(await session._playheadState.get('playheadRef')).toEqual(session.currentPlayheadRef);
    bandwidths.forEach(bw => {
      expect(tail(vod.getLiveMediaSequenceSegments(0)[bw])).toEqual(tail(transition[bw]));
      const manifest = vod.getLiveMediaSequences(103, bw, 0, 8);
      expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:103');
      expect(manifest).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:8');
      expect(manifest).toContain(tail(transition[bw]).uri);
    });
  });

  for (const options of [{}, { preserveLiveReturnTail: false }]) {
    it(`preserves legacy reload behavior with ${JSON.stringify(options)}`, async () => {
      const { session, vod, transition } = await reloadSession(options);
      expect(await session._sessionState.get('mediaSeq')).toEqual(100);
      expect(await session._sessionState.get('discSeq')).toEqual(7);
      expect(tail(vod.getLiveMediaSequenceSegments(0)['1200']).uri).not.toEqual(tail(transition['1200']).uri);
    });
  }

  it('does not align insert-after reloads when the option is enabled', async () => {
    const { session } = await reloadSession({ preserveLiveReturnTail: true }, true);
    expect(await session._sessionState.get('mediaSeq')).toEqual(100);
    expect(await session._sessionState.get('discSeq')).toEqual(7);
  });

  it('rejects partial serialization for the opt-in path while retaining existing partial-store callers', async () => {
    expect(() => new Session({}, { preserveLiveReturnTail: true, partialStoreHLSVod: true }, {})).toThrowError(/partialStoreHLSVod/);
    expect(() => new Session({}, { partialStoreHLSVod: true }, {})).not.toThrow();
    const { vod, transition } = await reloadedVod();
    vod.skipSerializeMediaSequences = true;
    expect(() => align(vod, transition)).toThrowError(/partial|serializ/);
  });

  it('rejects explicitly enabled preservation with demuxed audio while retaining existing demuxed callers', () => {
    expect(() => new Session({}, { preserveLiveReturnTail: true, useDemuxedAudio: true }, {})).toThrowError(/muxed/);
    expect(() => new Session({}, { useDemuxedAudio: true }, {})).not.toThrow();
  });
});
