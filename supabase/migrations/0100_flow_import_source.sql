-- 0100_flow_import_source.sql
-- Kobly — Rascunho de fluxo trazido de arquivo (Kobly, ZapData ou Leona): origem "import".

alter table public.flow_graph_versions drop constraint if exists flow_graph_versions_source_check;
alter table public.flow_graph_versions add constraint flow_graph_versions_source_check check (source in ('editor', 'mcp', 'copilot', 'import'));
