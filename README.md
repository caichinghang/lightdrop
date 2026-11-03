# Lightdrop

Send a file from one screen to another device's camera — no pairing, no app,
no network required. Two things make it different from QR-stream tools like
decimen or txqr:

1. **Sound back-channel.** The receiver's speaker chirps short ACKs to the
   sender's microphone (~100 bit/s). The sender stops repeating segments that
   have already arrived, and speeds up or slows down the QR stream based on how
   many codes the camera actually catches.
2. **Automatic Wi-Fi upgrade.** The sender's WebRTC offer rides inside the QR
   stream; the receiver's answer is squeezed to 57 bytes and sent back by sound.
   If both devices can reach each other (same Wi-Fi or hotspot), the rest of the
   file moves over a direct data channel. Nobody taps "connect".

If there is no microphone or no shared network, it degrades to a plain
one-way optical stream.

**Live:** https://caichinghang.github.io/lightdrop/ — open it on both devices.

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
| Frame format | `src/core/frame.ts` | Self-describing 24-byte header; DATA / META / SIGNAL frames |
| Segments | `src/core/segments.ts` | File cut into 256 KiB segments, coded independently → no file-size cap, flat memory |
| Fountain code | `src/core/fountain.ts` | Systematic random linear code over GF(2); any ~k+2 frames rebuild a segment |
| Scheduler | `src/core/scheduler.ts` | Picks which segment to show next; uses ACKs to skip finished ones |
| Receiver | `src/core/receiver.ts` | Gaussian elimination per segment, CRC-32 check, writes to disk |
| Storage | `src/storage/` | OPFS via sync access handle in a worker; resumable via a manifest |
| Audio modem | `src/audio/modem.ts` | 17-tone differential MFSK, 2–4.4 kHz, sync tones + CRC-16 |
| Wi-Fi | `src/net/rtc.ts`, `src/net/wire.ts` | Compact answer (ufrag, pwd, fingerprint); raw segments over the data channel |
| QR | `src/workers/` | `qrcode` with pinned mask for encoding; `zxing-wasm` for decoding |

## Status

Verified:
- Unit tests: fountain decoding under loss, end-to-end scheduling with and
  without ACKs, mid-transfer density change, audio modem through a simulated
  noisy, echoing channel.
- Browser loopback: 1.5 MB through real QR encode → canvas → zxing → fountain
  → OPFS, byte-exact.
- WebRTC from the 57-byte compact answer opens a data channel in Chrome.

Not yet verified on real devices:
- Camera capture on iOS/Android, and the acoustic link through a real speaker
  and microphone.
- WebRTC across two devices using mDNS (`.local`) candidates — the default in
  browsers. This could not be tested in the sandbox.
