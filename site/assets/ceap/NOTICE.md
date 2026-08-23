# CEAP-360VR stimulus media notice

These eight files are one-minute research excerpts from the publicly distributed
CEAP-360VR video-stimulus archive. They are media assets and are **not** covered
by Affect Tracker's BSD-3-Clause software license.

Dataset citation:

> Xue, T., El Ali, A., Zhang, T., Ding, G., and Cesar, P. (2023).
> CEAP-360VR: A Continuous Physiological and Behavioral Emotion Annotation
> Dataset for 360° Videos. *IEEE Transactions on Multimedia*, 25, 243–255.
> <https://doi.org/10.1109/TMM.2021.3124080>

The [CEAP-360VR repository](https://github.com/cwi-dis/CEAP-360VR-Dataset)
describes the dataset as CC BY-NC 4.0. Its checked-in `License.txt` links to a
CC BY-NC-SA 4.0 deed despite naming CC BY-NC 4.0. Affect Tracker therefore uses
these files only for noncommercial research and treats ShareAlike as an
additional conservative condition until the dataset maintainers clarify the
link. Researchers remain responsible for confirming that their use and public
deployment satisfy the dataset and underlying-source terms.

The downloaded archive contains longer, silent H.264 source files. The CEAP
luminance notebook defines the validated excerpt offsets and frame counts. The
copies here were decoded from those exact frame ranges and re-encoded as
1920×1080 H.264 High/yuv420p, CRF 18, with BT.709 limited-range signalling and
the MP4 metadata placed at the beginning for HTTP streaming. No audio was
present in the distributed source files, so these hosted excerpts are silent.

| File | CEAP ID and title | Source offset | Frames / rate | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `ceap-v1-puppies.mp4` | V1 — Puppies host SourceFed for a day | 0 s | 1501 @ 25 fps | `48a0489beeb1910935746335d8cee56f011eb00d3699b652081075bc028a7287` |
| `ceap-v2-mountain.mp4` | V2 — Mountain Stillness | 10 s | 1801 @ 30000/1001 fps | `5f3f0590655c7565f23fa2e7b38f58f3ce183391e52ba301e42e5addc3139d33` |
| `ceap-v3-zombie.mp4` | V3 — Zombie Apocalypse Horror | 65 s | 1795 @ 30 fps | `3e59807bf27d7aa614ccdb073a1e2f854c5b925880e7be3f69dd26ead0de8fc4` |
| `ceap-v4-war-zone.mp4` | V4 — War Zone, corrected 30 fps source | 3 s | 1803 @ 30 fps | `d4857511451b2c56a4be1a4604f52d7fcbea53e0f62ae6c8b50cac89d8723f53` |
| `ceap-v5-speed-flying.mp4` | V5 — Speed Flying | 0 s | 1801 @ 30000/1001 fps | `c8d4772379d15df699bc8b128863c3a1972069463334d9afbe1bc2589674a0fa` |
| `ceap-v6-sunrise.mp4` | V6 — Malaekahana Sunrise | 0 s | 1801 @ 30000/1001 fps | `35bddfdd2769c06735d463dbc6a6978aff33716148042435586884ca015ab94d` |
| `ceap-v7-jailbreak.mp4` | V7 — Jailbreak 360 | 127 s | 1801 @ 30000/1001 fps | `71a683c9e08f0fc21cd238958517bfa9fc4ff33f7b348401e45fb24f039a2d25` |
| `ceap-v8-nepal.mp4` | V8 — The Nepal Earthquake Aftermath | 41 s | 1801 @ 30000/1001 fps | `82f2f8fed0d6274a323c8b387691412a2dd733b43e016aba4be5d60b2d27892b` |

Original video identifiers and published pilot valence/arousal ratings remain
in `site/src/webxr-stimuli.js` and are written into every WebXR CSV row.
