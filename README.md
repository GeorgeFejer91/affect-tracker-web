# Affect Tracker Web

A dependency-free, browser-only 2D affect tracker inspired by [AffectTracker](https://github.com/afourcade/AffectTracker). It maps valence and arousal to the shape, regularity, speed, projection amplitude, color, and saturation of a draggable SVG widget.

Live site: <https://GeorgeFejer91.github.io/affect-tracker-web/>

## Controls

| Input | Effect |
| --- | --- |
| Left/Right or A/D | Decrease/increase valence |
| Up/Down or W/S | Increase/decrease arousal |
| Mouse wheel or trackpad | Change arousal |
| Shift + wheel | Change valence |
| Space | Pause or resume shape motion |
| R | Return the affect target to neutral |
| Drag the shape | Move the widget without changing affect |

Continuous mode moves while a direction is held. Step mode changes the target by `0.1` per press. The on-screen direction pad follows the selected mode.

## Visual mapping

The animation preserves the default AffectTracker mapping while using deterministic seeded irregularity and frame-rate-independent input smoothing:

```text
frequency = 1.5 + arousal             (0.5–2.5 Hz)
amplitude = 0.3 + 0.1 × arousal       (0.2–0.4)
shape mix = (valence + 1) / 2          (pointy→rounded)
disorder  = 0.4 × (1 - valence)        (irregular→regular)
```

The SVG has 192 radial samples and 16 projections. Polar angle selects the green→red→green color gradient, while distance from neutral controls saturation.

## Logging and privacy

The page keeps a fixed-size ring buffer of at most 10,000 records:

- Semantic input events such as key/button presses, wheel changes, resets, mode changes, drag completion, export, and buffer clearing.
- Affect samples at 20 Hz while the page is visible.

Everything stays inside the current browser tab. Nothing is uploaded, and there are no analytics or external network dependencies. Closing or refreshing the page discards records that have not been downloaded. Use **Download CSV** to export the current session in chronological order.

The widget position, widget size, panel state, and input mode are saved in `localStorage`. Affect values and history are not persisted.

## Accessibility

- All controls use semantic HTML and visible keyboard focus states.
- The widget exposes its current coordinates to assistive technology.
- Status changes use a polite live region.
- When `prefers-reduced-motion` is enabled, whole-body pulsing is disabled and projection motion is reduced without disabling input or logging.

## Run locally

No build is required. Serve the `site` directory through any static server:

```sh
python -m http.server 8000 --directory site
```

Then open <http://localhost:8000/>. Opening `index.html` directly is not recommended because browser security rules can block ES module imports from `file:` URLs.

## Test

The unit suite uses Node.js 22's built-in test runner and has no package dependencies:

```sh
npm test
```

It covers the affect mappings, normalized profiles, deterministic offsets, path generation, smoothing, keyboard/wheel movement, widget constraints, ring-buffer rollover, session reset, and CSV escaping.

## Deployment

Pushes to `main` run the tests and deploy only the contents of `site/` through GitHub Actions and GitHub Pages. In the repository settings, Pages must use **GitHub Actions** as its source.

## Attribution and license

The affect mapping, circular projection model, and visual concept derive from:

> Fourcade A, Malandrone F, Roellecke L, Ciston A, Mooij JD, Villringer A, Carletto S and Gaebler M (2025). AffectTracker: real-time continuous rating of affective experience in immersive virtual reality. Frontiers in Virtual Reality 6:1567854. <https://doi.org/10.3389/frvir.2025.1567854>

The original AffectTracker project is Copyright © 2024 Antonin Fourcade and is distributed under the BSD 3-Clause License. This web implementation retains that license and attribution; see [LICENSE](./LICENSE).
