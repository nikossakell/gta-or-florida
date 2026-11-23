/**
 * Mirror of the owner-reviewed registry (packages/config/sources.policy.json)
 * into D1, so scheduling/serving can join on it. The registry in Git is the
 * source of truth; this only copies it. No route can set permissions directly.
 */
import type { SourcePolicy } from '@gof/core';
import { POLICY_VERSION, REGISTRY } from '@gof/config';
import { logStmt } from '../db/repo.ts';

export function sourceUpsertStmt(db: D1Database, src: SourcePolicy, policyVersion: string): D1PreparedStatement {
  const approved = src.licenseStatus === 'approved';
  return db
    .prepare(
      `INSERT INTO sources (id, type, name, canonical_host, license_status, can_display_original_title, can_use_editorial_summary,
         auto_publish_allowed, policy_version, reviewed_by, reviewed_at, terms_url, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, canonical_host = excluded.canonical_host,
         license_status = excluded.license_status, can_display_original_title = excluded.can_display_original_title,
         can_use_editorial_summary = excluded.can_use_editorial_summary, auto_publish_allowed = excluded.auto_publish_allowed,
         policy_version = excluded.policy_version, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
         terms_url = excluded.terms_url, notes = excluded.notes, updated_at = excluded.updated_at`,
    )
    .bind(
      src.id,
      src.type,
      src.name,
      src.hosts[0]!,
      src.licenseStatus,
      approved && src.canDisplayOriginalTitle ? 1 : 0,
      approved && src.canUseEditorialSummary ? 1 : 0,
      approved && src.autoPublishAllowed ? 1 : 0,
      policyVersion,
      src.reviewedBy ?? null,
      src.reviewedAt ?? null,
      src.termsUrl ?? null,
      src.notes ?? null,
    );
}

/** Copy every registry entry into D1 (idempotent). */
export async function syncSources(db: D1Database, actorId: string): Promise<{ synced: number; policyVersion: string }> {
  const stmts = REGISTRY.sources.map((src) => sourceUpsertStmt(db, src, POLICY_VERSION));
  stmts.push(logStmt(db, { entityType: 'source', entityId: '*', decision: 'registry_sync', actorType: 'human', actorId, policyVersion: POLICY_VERSION, details: { count: REGISTRY.sources.length } }));
  await db.batch(stmts);
  return { synced: REGISTRY.sources.length, policyVersion: POLICY_VERSION };
}
