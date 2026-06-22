import asyncio
import os
import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from mock_backend.main import app

ROOT = Path(__file__).resolve().parents[1]


def test_stdio_server_discovers_nine_tools_and_calls_mock():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=port, log_level="critical", ws="none"
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while not server.started and time.time() < deadline:
        time.sleep(0.01)
    assert server.started

    async def run():
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "swipe_mcp"],
            cwd=ROOT,
            env={
                **os.environ,
                "SWIPE_MODE": "mock",
                "SWIPE_BACKEND_URL": f"http://127.0.0.1:{port}",
            },
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                call_result = await session.call_tool(
                    "list_customers", {"page": 1, "limit": 2}
                )
                return tools, call_result

    try:
        result, call_result = asyncio.run(run())
        names = {tool.name for tool in result.tools}
        assert names == {
            "find_customer",
            "list_customers",
            "list_products",
            "create_invoice",
            "record_payment",
            "reconcile",
            "list_invoices",
            "customer_outstanding",
            "lookup_gstin",
        }
        assert call_result.isError is False
        assert call_result.structuredContent["returned"] == 2
    finally:
        server.should_exit = True
        thread.join(timeout=5)
