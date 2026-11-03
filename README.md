# Lightdrop

Send a file from one screen to another device's camera: no pairing, no app,
no network required.

**Live:** https://caichinghang.github.io/lightdrop/ (open it on both devices).

What's different from QR-stream tools like decimen, txqr or cimbar:

1. **A custom optical code instead of QR.** Each frame is a single large
   black-and-white grid. Four finders locate it, and a lattice of alignment
   marks corrects lens distortion. The data is carried as many *independent*
   Reed–Solomon blocks, each a horizontal band with its own label. A blurry
   corner costs only the blocks in that corner. A capture torn by the screen
   refresh (half one frame, half the next) still yields good blocks from both
   frames. Decoding is plain sampling, about 15 ms per 720p frame in a desktop
   browser.
2. **Sound back-channel.** The receiver's speaker chirps short ACKs to the
   sender's microphone (~100 bit/s). The sender stops repeating finished
   segments, and Auto raises the density for as long as throughput keeps
   improving.
3. **Automatic Wi-Fi upgrade.** The sender's WebRTC offer rides inside the
   optical stream, and the receiver's 57-byte answer goes back by sound. If
   both devices can reach each other, the rest moves over a direct data
   channel. This can be switched off for school or office networks.

The interface is 1-bit: black ink, white paper, pixel fonts, and pixel art
drawn from text maps.

## Run

```bash
npm install
npm run dev        # https on your LAN — open the printed Network URL on both devices
npm test           # fountain code, scheduler, frame format, audio modem
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
| Scheduler | `src/core/scheduler.ts` | Picks which segment to send next; uses ACKs to skip finished ones |
| Receiver | `src/core/receiver.ts` | Gaussian elimination per segment, writes finished segments to disk |
| Storage | `src/storage/` | OPFS via sync access handle in a worker; resumable via a manifest |
| Audio modem | `src/audio/modem.ts` | 17-tone differential MFSK, 2–4.4 kHz, sync tones + CRC-16 |
| Wi-Fi | `src/net/` | Compact answer (ufrag, pwd, fingerprint); raw segments over the data channel |
| UI | `src/ui/` | 1-bit windows, pixel sprites (`pixels.ts`), ASCII status |

## Status

Verified:
- `npm test`: fountain code, scheduler with and without ACKs, audio modem
  through a simulated noisy room, Reed–Solomon, and the optical detector on
  synthetic photos with tilt, lens barrel, blur, noise, 90°/180° rotation and
  torn frames.
- `/e2e.html`: the real receive screen fed by a simulated 720p camera.
  HYPER level reached ~190 KB/s; a 2 MB file arrived byte-exact.

Not yet verified on real devices: speed with a real phone camera, and the
acoustic link through a real speaker and microphone.
