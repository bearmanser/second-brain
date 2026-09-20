---
title: Compare direct and proxied TTFT r1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e
type: lesson
permalink: freellmapi/lessons/0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/compare-direct-and-proxied-ttft-r1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e
tags:
  - streaming
created: 2026-09-01T00:00:00Z
modified: 2026-09-01T00:05:00Z
brain_schema_version: 1
brain_id: 0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d
brain_revision_id: 1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e
brain_title: Compare direct and proxied TTFT
brain_scope: freellmapi
brain_status: candidate
brain_operation_id: 11111111-1111-4111-8111-111111111111
brain_parents: []
owner_label: Keep this
---

## Situation

First-token latency looked worse after streaming traffic was routed through the proxy.

## Lesson

Measure the direct and proxied request with the same prompt before attributing the difference to the proxy.

## Applicability

Applies to synthetic streaming benchmarks in the freellmapi scope.

## Evidence

```yaml
- kind: test_run
  ref: benchmark-fixture-1
  description: Synthetic direct/proxy measurements
```

## Related

```yaml
[]
```

## Extra observations

A human added this section in Obsidian and it must survive a revised write.
