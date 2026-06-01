"""Mock FastAPI implementation of Swipe's Partner API (v2).

Built entirely against the public OpenAPI spec (../spec/partner.yaml) so the
frontend / MCP server can be developed and demoed without a live Swipe account.
Response shapes mirror the spec; the GST math is computed for real.
"""

__version__ = "0.1.0"
