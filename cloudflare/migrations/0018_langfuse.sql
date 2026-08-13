-- Links a locally-recorded call to the trace Langfuse (see src/langfuse.ts) created for the same
-- call, so the dev console's trace detail can link straight into Langfuse's richer view -- the
-- timeline, the cost breakdown, and any LLM-as-judge scores configured there. Null whenever
-- Langfuse isn't configured or the send failed, which never blocks the local trace from being
-- written -- see llm.ts's record().
ALTER TABLE llm_traces ADD COLUMN langfuse_trace_id TEXT;
