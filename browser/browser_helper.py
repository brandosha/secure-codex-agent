"""Helpers for accessing named pages across the Chromium instance.

Scripts connect to Chromium over CDP and request a page by a required logical
name. Each helper returns a Playwright Page directly; advanced callers can
access its browser context through ``page.context``.

The page name is installed with ``page.add_init_script()``, so it is restored
when that page reloads or navigates while Chromium remains running. The name is
not durable across a complete Chromium restart.
"""

import json

from playwright.async_api import Browser as AsyncBrowser
from playwright.async_api import Page as AsyncPage
from playwright.async_api import Playwright as AsyncPlaywright
from playwright.async_api import async_playwright
from playwright.sync_api import Browser as SyncBrowser
from playwright.sync_api import Page as SyncPage
from playwright.sync_api import Playwright as SyncPlaywright
from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"
PAGE_NAME_PROPERTY = "__SECURE_CODEX_AGENT_PAGE_NAME__"

_sync_playwright: SyncPlaywright | None = None
_sync_browser: SyncBrowser | None = None
_async_playwright: AsyncPlaywright | None = None
_async_browser: AsyncBrowser | None = None


def _validate_page_name(page_name: str) -> str:
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")
    return page_name


def _build_page_name_script(page_name: str) -> str:
    serialized_page_name = json.dumps(page_name)
    return f"""
(() => {{
    Object.defineProperty(window, "{PAGE_NAME_PROPERTY}", {{
        value: {serialized_page_name},
        configurable: true,
        enumerable: false,
        writable: false,
    }});
}})()
"""


def _get_sync_browser() -> SyncBrowser:
    global _sync_playwright, _sync_browser

    if _sync_browser is None or not _sync_browser.is_connected():
        _sync_playwright = sync_playwright().start()
        _sync_browser = _sync_playwright.chromium.connect_over_cdp(CDP_URL)

    return _sync_browser


async def _get_async_browser() -> AsyncBrowser:
    global _async_playwright, _async_browser

    if _async_browser is None or not _async_browser.is_connected():
        _async_playwright = await async_playwright().start()
        _async_browser = await _async_playwright.chromium.connect_over_cdp(CDP_URL)

    return _async_browser


def get_browser_page_sync(page_name: str) -> SyncPage:
    """Return the synchronously managed page with ``page_name``.

    The helper connects to the persistent Chromium instance, searches its
    available browser contexts, and returns the one page carrying the requested
    logical name. If no page matches, it creates and names a new page in the
    normal persistent context.

    Raises:
        ValueError: If ``page_name`` is blank.
        RuntimeError: If no browser context exists or the name is duplicated.
    """
    page_name = _validate_page_name(page_name)
    browser = _get_sync_browser()

    if not browser.contexts:
        raise RuntimeError("Persistent Chromium has no browser context")

    matching_pages = [
        page
        for context in browser.contexts
        for page in context.pages
        if not page.is_closed()
        and page.evaluate(f"window.{PAGE_NAME_PROPERTY} ?? null") == page_name
    ]

    if len(matching_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    page = matching_pages[0] if matching_pages else browser.contexts[0].new_page()
    page_name_script = _build_page_name_script(page_name)
    page.add_init_script(page_name_script)
    page.evaluate(page_name_script)
    return page


async def get_browser_page(page_name: str) -> AsyncPage:
    """Return the asynchronously managed page with ``page_name``.

    The helper connects to the persistent Chromium instance, searches its
    available browser contexts, and returns the one page carrying the requested
    logical name. If no page matches, it creates and names a new page in the
    normal persistent context.

    Raises:
        ValueError: If ``page_name`` is blank.
        RuntimeError: If no browser context exists or the name is duplicated.
    """
    page_name = _validate_page_name(page_name)
    browser = await _get_async_browser()

    if not browser.contexts:
        raise RuntimeError("Persistent Chromium has no browser context")

    matching_pages = []
    for context in browser.contexts:
        for page in context.pages:
            if (
                not page.is_closed()
                and await page.evaluate(
                    f"window.{PAGE_NAME_PROPERTY} ?? null"
                ) == page_name
            ):
                matching_pages.append(page)

    if len(matching_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    page = (
        matching_pages[0]
        if matching_pages
        else await browser.contexts[0].new_page()
    )
    page_name_script = _build_page_name_script(page_name)
    await page.add_init_script(page_name_script)
    await page.evaluate(page_name_script)
    return page
