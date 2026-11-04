# Lightdrop

Send a file from one screen to another device's camera: no pairing, no app,
no network required.

**Live:** https://caichinghang.github.io/lightdrop/ (open it on both devices).

One-way and offline: no Wi-Fi, no Bluetooth, no sound, no internet, nothing
to connect. The sender loops the file as a full-window black-and-white
pattern, and any camera (a phone, or a laptop webcam) reads it.

- **A custom optical code instead of QR.** Each frame is a single large grid:
  four finders locate it, and a lattice of alignment marks corrects lens
  distortion. The data is carried as many *independent* Reed–Solomon blocks,
  each a horizontal band with its own label. A blurry corner costs only the
  blocks in that corner, and a capture torn by the screen refresh still yields
  good blocks from both frames.
- **Fountain-coded.** Blocks can arrive in any order and missed frames don't
  matter: the receiver finishes as soon as it has caught enough of them.
- **No back-channel, so the receiver guides you.** It says when to press
  GRID − / FPS − (bigger squares, slower changes) or GRID + on the sender.
  The settings are remembered per device.

The interface is 1-bit: black ink, white paper, pixel fonts, and pixel art
drawn from text maps. The camera view is a live dithered rendering.

## Run

```bash
npm install
npm run dev        # https on your LAN — open the printed Network URL on both devices
npm test           # fountain code, scheduler, frame format, optical code
npm run build      # static site → dist/
```

Phones need HTTPS for camera/mic: accept the self-signed certificate once.
For desktop-only work, `NO_SSL=1 npx vite` serves plain HTTP on localhost.
`/loopback.html?size=N` is a dev harness that pipes the sender canvas straight
into the real decoder and receiver (no camera needed).

## How it works

| Piece | File | Notes |
|---|---|---|
| Optical code | `src/optical/` | Layout, encoder, detector (finders → size/orientation search → mesh → sampling), RS(255,223) |
| Block format | `src/core/frame.ts` | Self-describing 223-byte blocks: DATA / META / SIGNAL |
| Segments | `src/core/segments.ts` | File cut into 128 KiB segments, coded independently, so file size is unlimited and memory use stays flat |
| Fountain code | `src/core/fountain.ts` | Systematic random linear code over GF(2); any ~k+2 blocks rebuild a segment |
| Scheduler | `src/core/scheduler.ts` | Loops over segments, giving each enough blocks per pass |
| Receiver | `src/core/receiver.ts` | Gaussian elimination per segment, writes finished segments to disk |
| Storage | `src/storage/` | OPFS via sync access handle in a worker; resumable via a manifest |
| UI | `src/ui/` | 1-bit windows, pixel sprites (`pixels.ts`), ASCII status |

## Status

Verified:
- `npm test`: fountain code, scheduler, Reed–Solomon, and the optical detector
  on synthetic photos with tilt, lens barrel, blur, noise, 90°/180° rotation,
  torn frames, and a laptop webcam reading a phone in a dark room (glare,
  clipped whites, small in frame).
- `/e2e.html`: the real receive screen fed by a simulated 720p camera.

Not yet verified on real devices: the new defaults (computer sender: grid 224
at 15 fps; phone sender: grid 80 at 10 fps).
