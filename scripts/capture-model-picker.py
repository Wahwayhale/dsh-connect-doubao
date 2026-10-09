# -*- coding: utf-8 -*-
"""
Capture the DSH model picker showing the Doubao entries.

Same isolated web host, same rules: nothing fabricated, nothing on the user's
desktop profile or GUI. Opens the composer model selector and screenshots it.
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

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


def note(msg):
    print(msg, flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    ctx = browser.new_context(viewport={"width": 1500, "height": 950}, device_scale_factor=2)
    page = ctx.new_page()

    note(f"opening {BASE}")
    page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    time.sleep(6)

    # The composer carries the current model selector; its label shows the active
    # model. Click whatever holds that label.
    opened = False
    for sel in [
        "button:has-text('Default')",
        "[class*='model'] button",
        "[class*='selector'] button",
        "button[aria-haspopup='menu']",
        "[data-slot='conversation.composer'] button",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=4000, force=True)
                opened = True
                note(f"model selector opened via {sel}")
                break
        except Exception as exc:  # noqa: BLE001
            note(f"  {sel} failed: {str(exc).splitlines()[0]}")
    if not opened:
        note("MODEL SELECTOR NOT FOUND — dumping candidate buttons")
        try:
            btns = page.locator("button")
            note(f"  button count = {btns.count()}")
            for i in range(min(btns.count(), 40)):
                t = (btns.nth(i).inner_text() or "").strip().replace("\n", " ")
                if t:
                    note(f"   [{i}] {t[:60]!r}")
        except Exception as exc:  # noqa: BLE001
            note(f"  button dump failed: {exc}")

    time.sleep(3)

    # The composer's model control is a two-level menu: a summary row that shows
    # the ACTIVE model ("模型  豆包 快速") with a chevron, then the full list. The
    # summary alone already proves the provider registered, but the list is what
    # shows the whole catalog, so open the submenu.
    expanded = False
    for sel in [
        "[role='menuitem']:has-text('模型')",
        "[role='menuitem'] >> text=豆包",
        "[class*='menu'] >> text=模型",
        "text=模型",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                loc.hover(timeout=3000)
                time.sleep(1)
                loc.click(timeout=4000, force=True)
                expanded = True
                note(f"model submenu opened via {sel}")
                break
        except Exception as exc:  # noqa: BLE001
            note(f"  submenu {sel} failed: {str(exc).splitlines()[0]}")
    if not expanded:
        note("MODEL SUBMENU NOT EXPANDED")

    time.sleep(4)
    page.screenshot(path=str(OUT))

    body = page.inner_text("body")
    note("--- evidence probes ---")
    for needle in ["豆包（Doubao）", "豆包 快速", "豆包 2.1 Lite", "豆包 2.1 Pro",
                   "豆包 2.1 Turbo", "自动", "0921 新版", "即将下线"]:
        note(f"page contains {needle!r}: {needle in body}")

    browser.close()

note(f"written: {OUT}")
