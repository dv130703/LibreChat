import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import { generateShortLivedToken } from '~/crypto/jwt';

interface GuidanceEntry {
  id: string;
  category: string;
  title: string;
  text: string;
}

interface GuidanceResponse {
  count: number;
  entries: GuidanceEntry[];
}

const CATEGORY_HEADINGS: Record<string, string> = {
  checklist: 'Before you build the document',
  styling: 'What this tool can and cannot render',
  review: 'Check before you return it',
};

/** Guidance is shared, static reference material, so one fetch serves every user
 *  and every turn. Cached with a short TTL so edits to the LanceDB table appear
 *  without a restart, and a failed fetch retries on the next request. */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { text: string; expiresAt: number } | null = null;

function formatEntries(entries: GuidanceEntry[]): string {
  const byCategory = new Map<string, GuidanceEntry[]>();
  for (const entry of entries) {
    const group = byCategory.get(entry.category);
    if (group) {
      group.push(entry);
      continue;
    }
    byCategory.set(entry.category, [entry]);
  }

  const sections: string[] = [];
  for (const [category, group] of byCategory) {
    const heading = CATEGORY_HEADINGS[category] ?? category;
    const lines = group.map((entry) => `- ${entry.title}: ${entry.text}`);
    sections.push(`${heading}:\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Authoring rules for `create_document`, read from the RAG service's `guidance`
 * table and injected as the tool's system context.
 *
 * Returns undefined when the service is unset or unreachable: the guidance
 * improves output quality but the tool must still work without it.
 */
export async function buildDocumentGuidanceContext(userId: string): Promise<string | undefined> {
  if (!process.env.RAG_API_URL) {
    return undefined;
  }

  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.text;
  }

  try {
    const token = generateShortLivedToken(userId);
    const { data } = await axios.post<GuidanceResponse>(
      `${process.env.RAG_API_URL}/guidance`,
      {},
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 5000,
      },
    );

    if (!data?.entries?.length) {
      return undefined;
    }

    const text = `Document authoring rules — follow these whenever you call the create_document tool.\n\n${formatEntries(
      data.entries,
    )}`;
    cached = { text, expiresAt: now + CACHE_TTL_MS };
    logger.debug(`[create_document] loaded ${data.entries.length} guidance entries`);
    return text;
  } catch (error) {
    logger.warn(
      `[create_document] guidance unavailable at ${process.env.RAG_API_URL}/guidance; continuing without it:`,
      error,
    );
    return undefined;
  }
}
