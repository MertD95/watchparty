window.WPDirectPlayFixtureCases = Object.freeze({
  directUrl: {
    label: 'Portable direct URL',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-direct',
      resolvedUrl: 'https://cdn.watchparty.test/media/movie.mp4',
    },
  },
  torrentPortable: {
    label: 'Portable torrent infoHash',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-torrent',
      infoHash: '8ca6f333316aba4a769fdb8c2d5824eb9bb92763',
    },
  },
  debridUrl: {
    label: 'Debrid stream',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-debrid',
      resolvedUrl: 'https://real-debrid.example/stream/abc',
      addonTransportUrl: 'https://real-debrid.example/addon',
    },
  },
  notWebReady: {
    label: 'Not web ready',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-not-ready',
      resolvedUrl: 'https://cdn.watchparty.test/media/not-ready.mp4',
      behaviorHints: {
        notWebReady: true,
      },
    },
  },
  transportHeaders: {
    label: 'Proxy headers required',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-proxy',
      resolvedUrl: 'https://cdn.watchparty.test/media/proxy.mp4',
      behaviorHints: {
        proxyHeaders: {
          Authorization: 'Bearer fixture-token',
        },
      },
    },
  },
  external: {
    label: 'External provider stream',
    stream: {
      url: 'https://web.stremio.com/#/player/fixture-external',
      externalUrl: 'https://youtube.com/watch?v=fixture',
    },
  },
});
