import os
import asyncio
import json
from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastmcp import FastMCP
from playwright.async_api import async_playwright

# Initialize FastMCP 
mcp = FastMCP("Workspace Browser Engine")

# Global references to keep Playwright and the browser context alive
playwright = None
browser_context = None
BROWSER_PROFILE_DIR = "/home/agent/.browser-data/profile"
PAGE_NAME_PROPERTY = "__SECURE_CODEX_AGENT_PAGE_NAME__"

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

@asynccontextmanager
async def lifespan(app: FastAPI):
    global playwright, browser_context
    async with mcp_app.lifespan(mcp_app):
        print("🚀 Initializing persistent headless Chromium on port 9222...", flush=True)

        playwright = await async_playwright().start()
        browser_context = await playwright.chromium.launch_persistent_context(
            user_data_dir=BROWSER_PROFILE_DIR,
            headless=True,
            args=[
                "--remote-debugging-port=9222",
                "--no-sandbox",
                "--disable-gpu",
            ],
        )

        await wait_for_debug_port()
        print("✅ Headless Chromium is running and listening on port 9222.", flush=True)

        try:
            yield
        finally:
            print("🛑 Shutting down background Chromium instance...", flush=True)
            if browser_context:
                await browser_context.close()
                browser_context = None
            if playwright:
                await playwright.stop()
                playwright = None

# =====================================================================
# THE MCP TOOLS EXPOSED TO THE NODE AGENT
# =====================================================================
@mcp.tool()
async def list_browser_pages() -> list[dict[str, str | None]]:
    """List every open browser page with its logical name, URL, and title."""
    if browser_context is None:
        raise RuntimeError("Persistent Chromium is not initialized")

    pages = []
    for page in browser_context.pages:
        if page.is_closed():
            continue

        name = await page.evaluate(f"window.{PAGE_NAME_PROPERTY} ?? null")
        pages.append({
            "name": name,
            "url": page.url,
            "title": await page.title(),
        })

    return pages


@mcp.tool()
async def open_browser_page(page_name: str, url: str) -> dict[str, str]:
    """Open or reuse a named browser page and navigate it to the requested URL."""
    if browser_context is None:
        raise RuntimeError("Persistent Chromium is not initialized")
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")

    matching_pages = []
    for page in browser_context.pages:
        if (
            not page.is_closed()
            and await page.evaluate(f"window.{PAGE_NAME_PROPERTY} ?? null") == page_name
        ):
            matching_pages.append(page)

    if len(matching_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    page = matching_pages[0] if matching_pages else await browser_context.new_page()
    page_name_script = build_page_name_script(page_name)
    await page.add_init_script(page_name_script)
    await page.evaluate(page_name_script)
    await page.goto(url)

    return {
        "name": page_name,
        "url": page.url,
        "title": await page.title(),
    }


@mcp.tool()
async def close_browser_page(page_name: str) -> dict[str, str]:
    """Close the open browser page with the requested logical name."""
    if browser_context is None:
        raise RuntimeError("Persistent Chromium is not initialized")
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError("page_name must be a non-empty string")

    matching_pages = []
    for page in browser_context.pages:
        if (
            not page.is_closed()
            and await page.evaluate(f"window.{PAGE_NAME_PROPERTY} ?? null") == page_name
        ):
            matching_pages.append(page)

    if not matching_pages:
        raise RuntimeError(f"No open browser page is named {page_name!r}")
    if len(matching_pages) > 1:
        raise RuntimeError(f"Multiple browser pages are named {page_name!r}")

    await matching_pages[0].close()
    return {"closed": page_name}


@mcp.tool()
async def close_all_browser_pages() -> dict[str, int]:
    """Close every open page in the persistent browser context."""
    if browser_context is None:
        raise RuntimeError("Persistent Chromium is not initialized")

    pages = [page for page in browser_context.pages if not page.is_closed()]
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
