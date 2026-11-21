#!/usr/bin/env python3
"""Generates jackpot.wav from scratch (pure synthesis, no samples), so there is
nothing to license: dedicated to the public domain (CC0). Re-run to regenerate:
python3 make-jackpot.py
A slot-machine jackpot: a fast rising bell arpeggio, a cascade of coin clinks
pouring out underneath, then a shimmering major chord. 1.9 s. It is the sound of a
SURPRISE reset, distinct from the cha-ching of a normal one."""
import math, random, struct, wave
RATE, DUR = 44100, 1.9
random.seed(11)  # same file every time
buf = [0.0] * int(RATE * DUR)
def add(start, fn, length):
    s0 = int(start * RATE)
    for i in range(int(length * RATE)):
        if s0 + i < len(buf): buf[s0 + i] += fn(i / RATE)
def bell(freq, gain, decay, partials=((1.0, 1.0), (2.01, 0.45), (3.98, 0.22), (6.1, 0.10))):
    def f(t):
        env = math.exp(-t * decay) * min(1.0, t * 400)        # tiny attack: no click
        return gain * env * sum(a * math.sin(2 * math.pi * freq * m * t) for m, a in partials)
    return f
# rising arpeggio C6 E6 G6 C7
for k, fr in enumerate([1046.5, 1318.5, 1568.0, 2093.0]):
    add(k * 0.085, bell(fr, 0.28, 6.5), 0.7)
# the coin cascade: many short, bright, inharmonic clinks spread over 1.25 s, thickest early
t = 0.12
while t < 1.35:
    f0 = random.uniform(2400, 5400)
    add(t, bell(f0, random.uniform(0.07, 0.15), random.uniform(16, 28), ((1.0, 1.0), (2.76, 0.6), (5.4, 0.35))), 0.3)
    t += random.uniform(0.03, 0.075) * (0.6 + t)              # gaps widen as the cascade thins out
# shimmering chord C7 E7 G7 with a slow tremolo
def shimmer(t):
    env = math.exp(-t * 2.4) * min(1.0, t * 60)
    trem = 0.75 + 0.25 * math.sin(2 * math.pi * 9 * t)
    return env * trem * sum(0.15 * math.sin(2 * math.pi * f * t) + 0.05 * math.sin(2 * math.pi * f * 2.0 * t) for f in (2093.0, 2637.0, 3136.0))
add(0.42, shimmer, 1.45)
peak = max(abs(x) for x in buf) or 1.0
fade = int(0.08 * RATE); out = []
for i, x in enumerate(buf):
    g = 0.7 / peak
    if i > len(buf) - fade: g *= (len(buf) - i) / fade
    out.append(int(max(-1, min(1, x * g)) * 32767))
with wave.open("jackpot.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(struct.pack("<%dh" % len(out), *out))
print("wrote jackpot.wav,", round(len(out) / RATE, 2), "seconds")
