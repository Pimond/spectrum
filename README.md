# Spectrum

Live audio spectrum analyzer that runs entirely in the browser. No build step, no dependencies, nothing uploaded.

**Live:** https://pimond.github.io/spectrum/

## Features

- Five views: 3D surface (default), spectrum, 1/3-octave bars, waterfall (spectrogram) and scope
- Light theme by default, dark theme toggle in the header
- Sources: microphone, audio file, or a silent demo signal
- Independent zoom on each axis: pinch sideways / scroll for frequency, pinch vertically / Shift+scroll for level, drag to pan, double-tap to reset
- **Zero**: listens for 3 seconds, then subtracts that background from every graph for the rest of the session
- Peak frequency, musical note and level readout; tap the graph to read any frequency
- Log or linear frequency scale, FFT size 1024–32768, smoothing, peak hold, three heat color maps, PNG export

Keyboard: `Space` pause, `1`–`5` views, `Z` zero, `0` reset zoom.

## Files

- `index.html` — markup and styles
- `core.js` — math: axis transforms, resampling, peak finding, noise subtraction, color maps
- `views.js` — Canvas 2D and WebGL renderers
- `app.js` — Web Audio engine, gestures, UI

Serve the folder over any static server. Microphone access needs HTTPS or `localhost`.
