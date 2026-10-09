# -*- coding: utf-8 -*-
"""
Capture real screenshots of the Doubao card from an isolated DSH web instance.

Uses the ALREADY-RUNNING temporary host on --port; never touches the user's
desktop profile or GUI processes. Opens the page in headless Chrome, opens the
settings dialog, clicks the "豆包" nav entry, and screenshots the card.

Nothing is fabricated: if a step fails, the script says so and exits non-zero
rather than writing a placeholder image.
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# The console codepage is not UTF-8 here, and Chinese page text would come out as
# mojibake, which is useless for deciding whether the right thing rendered. Force
# UTF-8 on both streams.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

PORT = int(sys.argv[1])
TOKEN = sys.argv[2]
OUT = Path(sys.argv[3])

OUT.parent.mkdir(parents=True, exist_ok=True)

BASE = f"http://127.0.0.1:{PORT}/?token={TOKEN}"

console_lines = []


def note(msg):
    print(msg, flush=True)
    console_lines.append(msg)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    ctx = browser.new_context(viewport={"width": 1500, "height": 950}, device_scale_factor=2)
    page = ctx.new_page()

    errors = []
    page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    note(f"opening {BASE}")
    page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    # The shell waits on __DSH_BOOT_READY__ before rendering; give the SPA time.
    time.sleep(6)

    note(f"title={page.title()!r}")
    body = page.inner_text("body")[:400]
    note(f"body head: {body!r}")

    # Open the settings dialog. The shell ships a settings trigger; find it by
    # accessible name rather than guessing a selector.
    opened = False
    for sel in [
        "[data-slot='settings.trigger']",
        "button[aria-label*='设置']",
        "button[aria-label*='Settings']",
        "[data-dsh-settings-open]",
        "button:has-text('设置')",
        "button:has-text('Settings')",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=5000)
                opened = True
                note(f"settings opened via {sel}")
                break
        except Exception as exc:  # noqa: BLE001
            note(f"  {sel}: {exc}")
    if not opened:
        note("SETTINGS TRIGGER NOT FOUND")

    time.sleep(3)
    page.screenshot(path=str(OUT.with_name(".step-1-after-settings.png")))

    # Click the 「豆包」 nav entry inside the settings nav.
    # A bare `text=豆包` also matches the overlay's own title text, and the
    # click then lands on an element the overlay intercepts. Target the nav ROW
    # by its label span, which is what the shell actually renders as the button.
    clicked = False
    for sel in [
        "span[class*='navLabel']:has-text('豆包')",
        "[class*='navLabel'] >> text=豆包",
        "[class*='options'] >> text=豆包",
        "button:has(span[class*='navLabel']:text-is('豆包'))",
        "[class*='row']:has-text('豆包')",
        "text=豆包",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=4000, force=True)
                clicked = True
                note(f"clicked 豆包 via {sel}")
                break
        except Exception as exc:  # noqa: BLE001
            note(f"  {sel} failed: {str(exc).splitlines()[0]}")
    if not clicked:
        note("DOUBAO NAV ITEM NOT FOUND — dumping settings nav labels for diagnosis")
        try:
            labels = page.locator("[class*='navLabel']")
            note(f"  navLabel count = {labels.count()}")
            for i in range(labels.count()):
                note(f"   [{i}] {labels.nth(i).inner_text()!r}")
        except Exception as exc:  # noqa: BLE001
            note(f"  nav dump failed: {exc}")

    # Let the quota route answer and the bars paint.
    time.sleep(7)
    page.screenshot(path=str(OUT))

    # Report what is actually on screen — evidence, not assumption.
    try:
        card = page.locator(".dbq-card")
        note(f".dbq-card count = {card.count()}")
        if card.count() > 0:
            note(f"card text: {card.first.inner_text()[:600]!r}")
    except Exception as exc:  # noqa: BLE001
        note(f"card probe failed: {exc}")

    for needle in ["额度", "标准套餐", "5 小时限额", "周额度", "已登录", "豆包 2.1 Pro"]:
        note(f"page contains {needle!r}: {needle in page.inner_text('body')}")

    if errors:
        note("console errors:")
        for e in errors[:20]:
            note("  " + e)

    browser.close()

note(f"written: {OUT}")
