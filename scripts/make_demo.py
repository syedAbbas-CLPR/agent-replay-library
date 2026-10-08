#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "demo.gif"
POSTER = ROOT / "assets" / "demo-poster.png"
W, H = 1200, 675


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=1 if bold and candidate.endswith(".ttc") else 0)
    return ImageFont.load_default()


F9, F11, F13, F15, F20 = (font(n) for n in (9, 11, 13, 15, 20))
F11B, F13B, F15B, F20B = (font(n, True) for n in (11, 13, 15, 20))


def text(draw, xy, value, fill="#f5f5f5", f=F13):
    draw.text(xy, value, fill=fill, font=f)


def card(draw, box, outline="#2a2a2a", fill="#070707", radius=7, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def label(draw, x, y, value, color):
    width = int(draw.textlength(value, font=F9)) + 14
    draw.rounded_rectangle((x, y, x + width, y + 21), radius=10, outline=color, fill="#070707", width=1)
    text(draw, (x + 7, y + 4), value, color, F9)
    return width


def ease(value):
    return value * value * (3 - 2 * value)


def scene(frame):
    image = Image.new("RGB", (W, H), "#000000")
    d = ImageDraw.Draw(image)
    rail = 270
    d.rectangle((0, 0, rail, H), fill="#050505")
    d.line((rail, 0, rail, H), fill="#292929", width=1)
    text(d, (20, 20), "AGENT REPLAY", "#ffffff", F20B)
    text(d, (20, 49), "Claude and Codex sessions", "#777777", F11)
    card(d, (18, 77, 250, 112), "#343434", "#000000", 5)
    text(d, (30, 87), "Search sessions", "#777777", F11)

    sessions = [
        ("Build formation coordination", "CODEX", "army-sim", True),
        ("Fix cavalry charge behavior", "CLAUDE", "army-sim", False),
        ("Create replay reader", "CODEX", "tools", False),
        ("World editor investigation", "CLAUDE", "new-game", False),
    ]
    for i, (title, agent, project, active) in enumerate(sessions):
        y = 137 + i * 78
        card(d, (10, y, 260, y + 68), "#ffffff" if i == 0 else "#171717", "#101010" if i == 0 else "#050505", 6)
        text(d, (22, y + 10), title, "#ffffff" if i == 0 else "#d4d4d4", F11B)
        text(d, (22, y + 39), agent, "#5eead4" if agent == "CODEX" else "#fbbf24", F9)
        text(d, (83, y + 39), project, "#777777", F9)
        d.rounded_rectangle((232, y + 39, 250, y + 57), radius=3, outline="#444444", fill="#090909")
        text(d, (238, y + 40), "+", "#ffffff", F11B)
        if active:
            d.ellipse((241, y + 9, 248, y + 16), fill="#22c55e")

    x0, x1 = rail + 28, W - 24
    text(d, (x0, 20), "Build formation coordination", "#ffffff", F15B)
    text(d, (x0, 48), "ONE SESSION  •  COMPLETE TRACE", "#777777", F9)
    card(d, (W - 208, 18, W - 108, 48), "#333333", "#070707", 5)
    text(d, (W - 193, 27), "EXPORT ZIP", "#ffffff", F9)
    card(d, (W - 98, 18, W - 24, 48), "#333333", "#070707", 5)
    text(d, (W - 83, 27), "NOTES", "#ffffff", F9)

    card(d, (x0, 80, x1, 144), "#2c2c2c", "#0a0a0a", 5)
    d.rectangle((x0, 80, x0 + 4, 144), fill="#ffffff")
    text(d, (x0 + 17, 91), "HUMAN", "#ffffff", F9)
    text(d, (x0 + 17, 113), "Make infantry cohorts align side by side and share objectives.", "#ffffff", F13)

    phase = frame // 12
    local = ease((frame % 12) / 11)
    thinking_open = phase <= 1
    action_open = phase >= 1
    edit_open = phase >= 2
    note_on = phase >= 3

    think_y = 170
    think_h = 105 if thinking_open else 42
    card(d, (x0 + 26, think_y, x1, think_y + think_h), "#ffffff" if phase == 0 else "#333333", "#060606", 5, 2 if phase == 0 else 1)
    d.rectangle((x0 + 26, think_y, x0 + 30, think_y + think_h), fill="#a3a3a3")
    text(d, (x0 + 43, think_y + 11), "▼  THINKING", "#ffffff", F11B)
    if thinking_open:
        text(d, (x0 + 67, think_y + 43), "Map the cohort state machine and preserve physical formation authority.", "#b8b8b8", F11)
        text(d, (x0 + 67, think_y + 66), "Infantry line  →  shared frontage  →  target sectors", "#777777", F11)
    d.rounded_rectangle((x1 - 28, think_y + 10, x1 - 10, think_y + 28), radius=3, outline="#444444")
    text(d, (x1 - 23, think_y + 10), "+", "#ffffff", F11B)

    action_y = think_y + think_h + 16
    action_h = 224 if action_open else 44
    card(d, (x0 + 42, action_y, x1, action_y + action_h), "#ffffff" if phase == 1 else "#333333", "#050505", 5, 2 if phase == 1 else 1)
    d.rectangle((x0 + 42, action_y, x0 + 46, action_y + action_h), fill="#525252")
    label(d, x0 + 60, action_y + 11, "ACTIONS", "#ffffff")
    text(d, (x0 + 142, action_y + 14), "4 actions", "#e5e5e5", F11B)
    text(d, (x0 + 226, action_y + 14), "Search, Read, Edit, Test", "#777777", F11)

    if action_open:
        commands = [
            ("SEARCH", "rg cohort rust_extensions/src/army_sim.rs", "#60a5fa"),
            ("FILE READ", "army_sim.rs  190–365", "#d4d4d4"),
        ]
        cy = action_y + 48
        for kind, body, color in commands:
            card(d, (x0 + 78, cy, x1 - 18, cy + 39), "#282828", "#030303", 4)
            label(d, x0 + 88, cy + 9, kind, color)
            text(d, (x0 + 185, cy + 12), body, "#cfcfcf", F9)
            cy += 47

        edit_h = 88 if edit_open else 41
        card(d, (x0 + 78, cy, x1 - 18, cy + edit_h), "#2dd4bf" if phase == 2 else "#303030", "#030303", 4, 2 if phase == 2 else 1)
        label(d, x0 + 88, cy + 9, "CODE EDIT", "#5eead4")
        text(d, (x0 + 183, cy + 12), "Edit  rust_extensions/src/army_sim.rs", "#ffffff", F9)
        if edit_open:
            text(d, (x0 + 102, cy + 43), "+ formation_group.assign_frontage();", "#7cff6b", F11)
            text(d, (x0 + 102, cy + 64), "− choose_nearest_target_independently();", "#ff5a5f", F11)
        cy += edit_h + 8
        if cy + 38 < action_y + action_h:
            card(d, (x0 + 78, cy, x1 - 18, cy + 38), "#282828", "#030303", 4)
            label(d, x0 + 88, cy + 8, "TEST", "#c4b5fd")
            text(d, (x0 + 155, cy + 11), "34 army tests passed", "#d4d4d4", F9)

    bar_y = H - 66
    d.line((x0 + 16, bar_y, x1 - 90, bar_y), fill="#4a4a4a", width=4)
    peaks = [0.03, .12, .22, .34, .49, .63, .76, .91]
    active = min(7, phase * 2 + (1 if local > .55 else 0))
    for i, pct in enumerate(peaks):
        px = x0 + 16 + int((x1 - x0 - 106) * pct)
        height = 18 if i == active else 12
        color = "#facc15" if i == active else "#ffffff" if i < active else "#737373"
        d.polygon([(px, bar_y - height), (px + 7, bar_y), (px - 7, bar_y)], fill=color)
    text(d, (x1 - 78, bar_y - 8), "6:42", "#a3a3a3", F9)
    text(d, (x0 + 16, H - 39), "↑ ↓  prompts       ← →  major blocks and edits", "#a3a3a3", F9)

    if note_on:
        d.rounded_rectangle((x1 - 28, think_y + 10, x1 - 10, think_y + 28), radius=3, outline="#facc15", fill="#facc15")
        text(d, (x1 - 23, think_y + 10), "+", "#000000", F11B)
        card(d, (x1 - 310, 58, x1, 129), "#facc15", "#080808", 5)
        text(d, (x1 - 294, 70), "NOTE SAVED", "#facc15", F9)
        text(d, (x1 - 294, 94), "Keep the infantry frontage test.", "#ffffff", F11)

    cursor_points = [
        (x0 + 130, think_y + 20),
        (x0 + 175, action_y + 20),
        (x0 + 230, action_y + 155 if action_open else action_y + 20),
        (x1 - 158, 34),
    ]
    cx, cy = cursor_points[min(phase, 3)]
    d.polygon([(cx, cy), (cx + 4, cy + 18), (cx + 9, cy + 12), (cx + 16, cy + 20), (cx + 20, cy + 16), (cx + 12, cy + 9)], fill="#ffffff", outline="#000000")
    return image


def main():
    frames = [scene(i) for i in range(48)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[30].save(POSTER, optimize=True)
    frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=95, loop=0, optimize=True, disposal=2)
    print(OUT)


if __name__ == "__main__":
    main()
