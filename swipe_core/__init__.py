"""Pure, framework-free core shared by the mock backend and the MCP server.

This package has zero third-party dependencies. It owns the two things both
``mock_backend`` and ``swipe_mcp`` must agree on exactly: the GST line-item /
document math (``swipe_core.gst``) and the coded ``SwipeError`` exception
(``swipe_core.errors``). Keeping them here means the production MCP wrapper no
longer depends on the throwaway mock to compute or validate tax.
"""
