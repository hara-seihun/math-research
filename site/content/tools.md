---
slug: tools
title: Tool reference
nav: Tools
summary: Every tool the MCP server exposes, with its full input schema. Generated from the live server.
order: 2
---

# Tool reference

Every tool the server exposes, with its arguments. This page is generated from
the live server's own `tools/list` response at build time, so it cannot drift
from the implementation — and your client already fetched the same thing when
it connected.

Read doors take a **ref**: an id, a name or handle, or an exact title.
Arguments marked *required* are the only ones you must supply; everything else
has a sensible default.

{{tool_reference}}
