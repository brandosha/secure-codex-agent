import os
import asyncio
import json
from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastmcp import FastMCP
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

# Initialize FastMCP 
mcp = FastMCP("Workspace Browser Engine")

# Global references to keep Playwright and the browser context alive
playwright = None
browser: Browser | None = None
browser_context = None
launched_browser_context: BrowserContext | None = None
insecure_browser_context: BrowserContext | None = None
BROWSER_PROFILE_DIR = "/home/agent/.browser-data/profile"
PAGE_NAME_PROPERTY = "__SECURE_CODEX_AGENT_PAGE_NAME__"
NORMAL_CONTEXT = "normal"
INSECURE_CONTEXT = "insecure"

def build_page_name_script(page_name: str) -> str:
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

async def wait_for_debug_port(host: str = "127.0.0.1", port: int = 9222, timeout: float = 10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    last_error = None

    while asyncio.get_running_loop().time() < deadline:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            writer.close()
            await writer.wait_closed()
            return
        except OSError as error:
            last_error = error
            await asyncio.sleep(0.1)

    raise RuntimeError(f"Chromium did not open {host}:{port} within {timeout}s: {last_error}")

async def get_page_name(page: Page) -> str | None:
    return await page.evaluate(f"window.{PAGE_NAME_PROPERTY} ?? null")

def get_context_type(context: BrowserContext) -> str:
    return INSECURE_CONTEXT if context is insecure_browser_context else NORMAL_CONTEXT

async def find_named_pages(page_name: str) -> list[tuple[Page, str]]:
    if browser is None:
        raise RuntimeError("Persistent Chromium is not initialized")

    matches = []
    for context in browser.contexts:
        context_type = get_context_type(context)
        for page in context.pages:
            if not page.is_closed() and await get_page_name(page) == page_name:
                matches.append((page, context_type))
    return matches

async def name_page(page: Page, page_name: str) -> None:
    page_name_script = build_page_name_script(page_name)
    await page.add_init_script(page_name_script)
    await page.evaluate(page_name_script)

async def open_named_page(
    page_name: str,
    url: str,
    target_context: BrowserContext,
    target_context_type: str,
) -> dict[str, str]:
    matching_pages = await find_named_pages(page_name)
    conflicting_contexts = {
        context_type
        for _, context_type in matching_pages
        if context_type != target_context_type
    }
    if conflicting_contexts:
        conflicting_context = sorted(conflicting_contexts)[0]
        raise RuntimeError(
            f"Browser page {page_name!r} already exists in the "
            f"{conflicting_context!r} context; refusing to reuse it in the "
            f"{target_context_type!r} context"
        )

    matching_target_pages = [
        page
        for page, context_type in matching_pages
        if context_type == target_context_type
    ]
    if len(matching_target_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    page = (
        matching_target_pages[0]
        if matching_target_pages
        else await target_context.new_page()
    )
    await name_page(page, page_name)
    await page.goto(url)

    return {
        "name": page_name,
        "url": page.url,
        "title": await page.title(),
        "context": target_context_type,
    }

async def get_insecure_browser_context() -> BrowserContext:
    global insecure_browser_context

    if browser is None:
        raise RuntimeError("Persistent Chromium is not initialized")
    if insecure_browser_context is None:
        insecure_browser_context = await browser.new_context(
            ignore_https_errors=True,
        )
    return insecure_browser_context

@asynccontextmanager
async def lifespan(app: FastAPI):
    global playwright, browser, browser_context
    global launched_browser_context, insecure_browser_context
    async with mcp_app.lifespan(mcp_app):
        print("🚀 Initializing persistent headless Chromium on port 9222...", flush=True)

        playwright = await async_playwright().start()
        launched_browser_context = await playwright.chromium.launch_persistent_context(
            user_data_dir=BROWSER_PROFILE_DIR,
            headless=True,
            args=[
                "--remote-debugging-port=9222",
                "--no-sandbox",
                "--disable-gpu",
            ],
        )

        await wait_for_debug_port()
        browser = await playwright.chromium.connect_over_cdp(
            "http://127.0.0.1:9222"
        )
        if not browser.contexts:
            raise RuntimeError("Persistent Chromium has no browser context")
        browser_context = browser.contexts[0]
        print("✅ Headless Chromium is running and listening on port 9222.", flush=True)

        try:
            yield
        finally:
            print("🛑 Shutting down background Chromium instance...", flush=True)
            if insecure_browser_context:
                await insecure_browser_context.close()
                insecure_browser_context = None
            if launched_browser_context:
                await launched_browser_context.close()
                launched_browser_context = None
            if browser_context:
                browser_context = None
            browser = None
            if playwright:
                await playwright.stop()
                playwright = None

# =====================================================================
# THE MCP TOOLS EXPOSED TO THE NODE AGENT
# =====================================================================
@mcp.tool()
async def list_browser_pages() -> list[dict[str, str | None]]:
    """List every open browser page with its logical name, URL, and title."""
    if browser is None:
        raise RuntimeError("Persistent Chromium is not initialized")

    pages = []
    for context in browser.contexts:
        context_type = get_context_type(context)
        for page in context.pages:
            if page.is_closed():
                continue

            pages.append({
                "name": await get_page_name(page),
                "url": page.url,
                "title": await page.title(),
                "context": context_type,
            })

    return pages


@mcp.tool()
async def open_browser_page(page_name: str, url: str) -> dict[str, str]:
    """Open or reuse a named page in the normal certificate-validating context."""
    if browser_context is None:
        raise RuntimeError("Persistent Chromium is not initialized")
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")

    return await open_named_page(
        page_name,
        url,
        browser_context,
        NORMAL_CONTEXT,
    )


@mcp.tool()
async def open_insecure_browser_page(page_name: str, url: str) -> dict[str, str]:
    """Open or reuse a named page in an isolated context that ignores HTTPS errors.

    This bypasses all TLS certificate validation for the page's navigations and
    subresources. Its cookies, storage, permissions, and session state are
    isolated from the normal persistent browser context.
    """
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")

    context = await get_insecure_browser_context()
    return await open_named_page(
        page_name,
        url,
        context,
        INSECURE_CONTEXT,
    )


@mcp.tool()
async def close_browser_page(page_name: str) -> dict[str, str]:
    """Close the open browser page with the requested logical name."""
    if browser is None:
        raise RuntimeError("Persistent Chromium is not initialized")
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")

    matching_pages = await find_named_pages(page_name)

    if not matching_pages:
        raise RuntimeError(f"No open browser page is named {page_name!r}")
    if len(matching_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    page, context_type = matching_pages[0]
    await page.close()
    return {"closed": page_name, "context": context_type}


@mcp.tool()
async def close_all_browser_pages() -> dict[str, int]:
    """Close every open page in the persistent browser context."""
    if browser is None:
        raise RuntimeError("Persistent Chromium is not initialized")

    pages = [
        page
        for context in browser.contexts
        for page in context.pages
        if not page.is_closed()
    ]
    await asyncio.gather(*(page.close() for page in pages))
    return {"closed_count": len(pages)}


@mcp.tool()
async def execute_browser_script(page_name: str, script: str) -> str:
    """Execute a synchronous Python script with a named Playwright page.

    The script is a statement body, not a complete module. A synchronous
    Playwright ``page`` is predefined and is reused or created from
    ``page_name``. Use synchronous calls such as ``page.goto(...)`` without
    ``await``. Text printed by the script is returned as the tool result.
    """
    if not isinstance(page_name, str) or not page_name.strip():
        return "Execution Error: page_name must be a non-empty string"
    if not isinstance(script, str) or not script.strip():
        return "Execution Error: script must be a non-empty string"

    wrapper = f"""
import sys

sys.path.insert(0, "/home/agent/workspace/.browser")

from browser_helper import get_browser_page_sync

page = get_browser_page_sync({page_name!r})
script = {script!r}
exec(compile(script, "<browser-script>", "exec"), globals(), globals())
"""

    try:
        process = await asyncio.create_subprocess_exec(
            "python",
            "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(wrapper.encode())

        if process.returncode != 0:
            return (
                f"Execution Failure (Exit Code {process.returncode}):\n"
                f"{stderr.decode()}"
            )

        return stdout.decode()

    except Exception as error:
        return f"Internal Server Exception while executing script: {error}"


@mcp.tool()
async def execute_workspace_script(script_path: str) -> str:
    """
    Executes a Python Playwright script located within the shared workspace.
    The script path should be relative to the workspace, e.g., '.browser/my_task.py'.
    The script automatically hooks into the persistent browser window via browser_helper.py.
    """
    # Map the incoming relative path to our absolute Docker volume mount
    full_path = os.path.join("/home/agent/workspace", script_path)
    
    if not os.path.exists(full_path):
        return f"Execution Error: Script not found at workspace path '{script_path}'"

    try:
        # Run the script inside an isolated subprocess
        process = await asyncio.create_subprocess_exec(
            'python', full_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()
        
        # Capture standard execution failures
        if process.returncode != 0:
            return f"Execution Failure (Exit Code {process.returncode}):\n{stderr.decode()}"
            
        return stdout.decode()
        
    except Exception as e:
        return f"Internal Server Exception while executing script: {str(e)}"

# Convert our FastMCP instance into a standard streamable ASGI application.
mcp_app = mcp.http_app()

if __name__ == "__main__":
    import uvicorn
    fast_api_app = FastAPI(lifespan=lifespan)
    fast_api_app.mount("/", mcp_app)
    # Start the service inside the Docker network on port 8000
    uvicorn.run(fast_api_app, host="0.0.0.0", port=8000, access_log=False)
