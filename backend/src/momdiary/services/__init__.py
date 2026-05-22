"""Service-layer modules.

Feature 005 (`/v1/chatentry/`) adds two siblings:

* :mod:`momdiary.services.chatentry_dispatcher` — direct-LLM dispatcher
  (no MAF Agent / ChatAgent).
* :mod:`momdiary.services.chatentry_catalog` — projects the live tool
  registry into JSON Schema descriptors for the LLM.
"""
