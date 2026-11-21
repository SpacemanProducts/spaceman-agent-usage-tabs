#!/usr/bin/env python3
"""Generates cha-ching.wav from scratch (pure synthesis, no samples), so there
is nothing to license: dedicated to the public domain (CC0). Re-run to
regenerate:  python3 make-cha-ching.py
A short noise 'cha' tick, then two bright metallic bell notes ('ching'), 1.3 s."""
import math, random, struct, wave

RATE, DUR = 44100, 1.3
random.seed(7)  # same file every time
buf = [0.0] * int(RATE * DUR)

def add(start, fn, length):
    s0 = int(start * RATE)
    for i in range(int(length * RATE)):
        if s0 + i < len(buf):
            buf[s0 + i] += fn(i / RATE)

# 'cha': 35 ms band-limited noise burst with a fast decay
prev = 0.0
def cha(t):
    global prev
    prev = prev * 0.55 + random.uniform(-1, 1) * 0.45   # crude low-pass
    return prev * math.exp(-t * 90) * 0.55
add(0.0, cha, 0.06)

# 'ching': inharmonic partials (bell-like) with exponential decay
def bell(freq, gain, decay):
    partials = [(1.0, 1.0), (2.76, 0.55), (5.40, 0.30), (8.93, 0.14)]
    def f(t):
        env = math.exp(-t * decay)
        return gain * env * sum(a * math.sin(2 * math.pi * freq * m * t) for m, a in partials)
    return f
add(0.045, bell(1318.5, 0.34, 5.5), 0.9)    # E6
add(0.165, bell(1975.5, 0.42, 4.2), 1.1)    # B6, the bright second strike

peak = max(abs(x) for x in buf) or 1.0
fade = int(0.05 * RATE)
out = []
for i, x in enumerate(buf):
    g = 0.7 / peak                                   # about -3 dB below full scale
    if i > len(buf) - fade: g *= (len(buf) - i) / fade   # no click at the end
    out.append(int(max(-1, min(1, x * g)) * 32767))
with wave.open("cha-ching.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(struct.pack("<%dh" % len(out), *out))
print("wrote cha-ching.wav,", round(len(out) / RATE, 2), "seconds")
