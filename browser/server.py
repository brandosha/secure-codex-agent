import os
import asyncio
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
# THE MCP TOOL EXPOSED TO THE NODE AGENT
# =====================================================================
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
