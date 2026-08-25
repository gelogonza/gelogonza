# capture

Records the live project sites and encodes them as animated WebP loops for the
root `README.md`.

```bash
cd tools/capture && npm install     # once

npm run capture pointvis            # one target
npm run capture -- --all            # every target
npm run check                       # verify what the README references
```

Output lands in `assets/<name>.webp`.

## Why animated WebP

GitHub's markdown sanitizer **strips `<video>` tags entirely**, and renders an
`.mp4` URL in image syntax as a broken image. Neither survives in a README.
WebP passes through as a plain `<img>`, autoplays, loops, and runs about a
quarter the size of an equivalent GIF on this kind of content:

| Format | Same 3.5s clip | Renders? |
| --- | --- | --- |
| Animated WebP | 892 KB | yes, autoplays and loops |
| GIF | 3.1 MB | yes, but heavy and visibly dithered |
| MP4 via `<video>` | 688 KB | no — tag removed |

## Driving apps that need input

An audio visualizer with no audio is a black rectangle, so targets can declare
synthetic media and Chrome will serve it as a real device:

- `fakeAudio` — a generated rhythmic signal becomes the microphone
- `fakeCamera` — generated flowing blobs become the webcam, which a motion
  tracker follows like a moving body

Both are synthesised by ffmpeg at capture time. Nothing is committed, and no
one else's music is redistributed. Point either at `{ "file": "..." }` to use
your own instead.

## Adding a target

Append to `targets.json`:

```jsonc
{
  "name": "example",
  "source": { "url": "https://example.com" },
  "viewport": [1000, 625],
  "readyWhen": ".app-loaded",   // selector that means "really ready"
  "settle": 3000,               // ms to wait after that
  "steps": [
    { "clickText": "Start" },
    { "key": "2" },
    { "wait": 4000 },
    { "drag": { "selector": ".titlebar", "dx": -190, "dy": 55 } }
  ],
  "clip": { "start": 9, "duration": 5 },        // or "segments": [ ... ]
  "encode": { "width": 600, "fps": 15, "quality": 60 },
  "budgetKb": 1200
}
```

Getting the timing right usually takes one throwaway run: record long, then
pick `clip` from what actually happened. Two traps worth knowing —

- **`load` is not ready.** GeloOS plays a boot sequence first, so clicks fired
  too early land on the overlay and are swallowed. Use `readyWhen` + a generous
  `settle`.
- **Hidden elements match.** GeloOS keeps all 11 windows in the DOM at once;
  `.window` alone grabs a hidden one. Select `:visible`.

## Targets that can't be automated

Anything behind a login can't be driven headlessly — Syro is entirely behind
Spotify OAuth. Mark those `"source": { "manual": "reason" }`, screen-record the
app yourself, save it to `tools/capture/input/<name>.mov`, and re-run: the clip
is encoded through the same path, so it matches everything else.

## Verification

Every encode is parsed back before it is accepted. A WebP that came out as a
single still renders without error and silently defeats the point, so
`capture.mjs` re-reads the RIFF chunks and fails unless the file has more than
one `ANMF` frame and an `ANIM` loop count of 0 (infinite). `--check` runs the
same test over everything the README references, and flags missing files,
orphaned assets, and anything over budget.
