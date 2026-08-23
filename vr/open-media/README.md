# Open test media

`catalog.json` records reproducible source, license, projection, stereo layout, byte length, and SHA-256 data for optional Quest test videos. Video binaries are deliberately not committed to this repository.

Run `prepare-open-media.ps1` with an exported or already validated active manifest. The script downloads each pinned file into `media/`, verifies its bytes, and creates one standard version-1 per-video layout manifest in `sessions/`. It does not alter `active-session.json`. At runtime, the APK retains only each generated manifest's video identity/projection/stereo/loop and always overlays the active manifest's affect, Flubber, controller, and LSL profile.

```powershell
pwsh -NoProfile -File .\open-media\prepare-open-media.ps1 `
  -TemplateManifest C:\path\to\active-session.json `
  -DestinationRoot E:\Documents\AffectTrackerVR
```

The two NASA clips are mono equirectangular 360° videos. The Everest clip is an openly licensed flat satellite-terrain flyover, not a spherical video. Meta's Doggie clip is a flat 3840×1080 left/right stereo sample. These explicit distinctions are retained in every generated manifest; the APK never infers them.

Keep source-page attribution with any copied media. `OPEN-MEDIA-NOTICES.txt` is generated into the destination folder for that purpose.
