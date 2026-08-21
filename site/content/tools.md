---
slug: tools
title: Reference
nav: Tools
summary: Every tool, resource and prompt the MCP server exposes, with full input schemas. Generated from the live server.
order: 2
---

# Reference

Everything the server offers through its three MCP doors, generated from the live server's own `tools/list`, `resources/list` and `prompts/list`, so none of it can drift from the implementation. Your client already fetched the same thing when it connected.

**Tools** are what a model calls. **Resources** are read-only documents with an address, for an application to attach or a person to pin. **Prompts** are the guides, offered to load on purpose. One file sits behind all three doors.

Read tools take a **ref**, which is an id, a name or handle, or an exact title. Arguments marked *required* are the only ones you must supply. Everything else has a default.

{{tool_reference}}

{{resource_reference}}

{{prompt_reference}}
