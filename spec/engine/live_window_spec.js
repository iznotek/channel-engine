function channelEngine() {
  // Upstream keeps a module-level Fastify instance and session maps.
  delete require.cache[require.resolve('../../engine/server.js')];
  return require('../../engine/server.js').ChannelEngine;
}
const SessionLive = require('../../engine/session_live.js');
const Session = require('../../engine/session.js');

function shiftWindow(session) {
  const segments = Array.from({ length: 12 }, (_, i) => ({
    uri: `https://fixture.invalid/${i}.ts`, duration: 6,
  }));
  return session._shiftSegments({ totalDur: 72, segments: { 1000: segments } });
}

describe('Live playlist duration', () => {
  for (const [configured, expected] of [[undefined, 60], [6, 6], [12, 12], [120, 72]]) {
    it(`trims to ${configured === undefined ? 'the default 60' : configured} seconds`, () => {
      const live = new SessionLive({ livePlaylistDurationSeconds: configured }, {});
      const shifted = shiftWindow(live);
      expect(shifted.totalDuration).toEqual(expected);
      expect(shifted.shiftedSegments[1000].length).toEqual(expected / 6);
      expect(shifted.removedSegments).toEqual((72 - expected) / 6);
    });
  }

  for (const invalid of [null, 0, 5.99, 120.01, NaN, Infinity, -Infinity, '12']) {
    it(`rejects an invalid duration (${invalid}) in both public constructors`, () => {
      expect(() => new SessionLive({ livePlaylistDurationSeconds: invalid }, {})).toThrowError(/livePlaylistDurationSeconds/);
      expect(() => new (channelEngine())({}, { livePlaylistDurationSeconds: invalid })).toThrowError(/livePlaylistDurationSeconds/);
    });
  }

  for (const configured of [undefined, 12]) {
    it(`passes ${configured === undefined ? 'the default' : 'a configured'} window from ChannelEngine to SessionLive`, async () => {
      jasmine.clock().install();
      let live;
      spyOn(SessionLive.prototype, 'initAsync').and.callFake(async function () { live = this; });
      spyOn(SessionLive.prototype, 'startPlayheadAsync').and.returnValue(Promise.resolve());
      spyOn(Session.prototype, 'startPlayheadAsync').and.returnValue(Promise.resolve());
      try {
        const channelManager = { getChannels: () => [{ id: `live-window-${configured}`, profile: [] }] };
        const options = { channelManager, livePlaylistDurationSeconds: configured };
        const engine = new (channelEngine())({}, options);
        await engine.updateChannelsAsync(channelManager, options);
        expect(shiftWindow(live).totalDuration).toEqual(configured || 60);
      } finally {
        jasmine.clock().uninstall();
      }
    });
  }
});
