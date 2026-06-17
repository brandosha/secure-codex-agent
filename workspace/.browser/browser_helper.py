import os
import json
from playwright.sync_api import sync_playwright as sync_p
from playwright.async_api import async_playwright as async_p
from browser_use.dom.service import DomService as DomService

CDP_URL = "http://localhost:9222"

class BrowserSession:
    """Wrapper to standardize session payloads."""
    def __init__(self, page, context, browser):
        self.page = page
        self.context = context
        self.browser = browser

# ==========================================
# 1. SYNCHRONOUS / SEQUENTIAL METHOD
# ==========================================
def attach_to_session_sync() -> BrowserSession:
    """Synchronously connects to the background browser container."""
    p = sync_p().start()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0]
    page = context.pages[0] if len(context.pages) > 0 else context.new_page()
    return BrowserSession(page, context, browser)


# ==========================================
# 2. ASYNCHRONOUS / CONCURRENT METHOD
# ==========================================
async def attach_to_session_async() -> BrowserSession:
    """Asynchronously connects to the background browser container."""
    p = await async_p().start()
    browser = await p.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0]
    page = context.pages[0] if len(context.pages) > 0 else await context.new_page()
    return BrowserSession(page, context, browser)

