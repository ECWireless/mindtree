import {
  MAX_EXTERNAL_CITATION_OCCURRENCES,
  MAX_EXTERNAL_CITATION_SOURCES,
  MAX_EXTERNAL_CITATION_TITLE_LENGTH,
  MAX_EXTERNAL_CITATION_URL_LENGTH,
  type ExternalCitationMention,
  type ExternalCitationView,
} from "@/lib/citations/contracts";

export type ProviderUrlCitation = {
  type: "url_citation";
  start_index: number;
  end_index: number;
  title: string;
  url: string;
};

export class ExternalCitationValidationError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ExternalCitationValidationError";
  }
}

export type ExternalCitationProvenance = {
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
} & (
  | { owner: "assistant-message"; ownerId: string }
  | { owner: "synthesis-version"; ownerId: string }
);

export type ExternalCitationSource = {
  alias: string;
  title: string;
  url: string;
};

export type ExternalCitationEvidence = ExternalCitationSource & {
  excerpts: Array<{ before: string; after: string; truncatedBefore: boolean; truncatedAfter: boolean }>;
  provenance: ExternalCitationProvenance[];
};

const EXTERNAL_EVIDENCE_BEFORE_CHARACTERS = 160;
const EXTERNAL_EVIDENCE_AFTER_CHARACTERS = 40;

export function normalizeExternalTitle(value: string) {
  const title = value.trim().replace(/\s+/g, " ");
  if (
    title.length < 1 ||
    title.length > MAX_EXTERNAL_CITATION_TITLE_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(title)
  ) {
    throw new ExternalCitationValidationError("invalid-title");
  }
  return title;
}

export function createExternalCitationEvidence(input: {
  content: string;
  citations: readonly ExternalCitationView[];
  owner: ExternalCitationProvenance["owner"];
  ownerId: string;
}) {
  const byOrdinal = new Map<number, ExternalCitationEvidence>();
  const seenUrls = new Set<string>();
  const ordered = [...input.citations].sort((left, right) =>
    left.ordinal - right.ordinal || left.startUtf16 - right.startUtf16
  );
  for (const citation of ordered) {
    if (
      citation.kind !== "external" ||
      !Number.isSafeInteger(citation.ordinal) ||
      citation.ordinal < 1 ||
      citation.ordinal > MAX_EXTERNAL_CITATION_SOURCES ||
      !Number.isSafeInteger(citation.startUtf16) ||
      citation.startUtf16 < 0 ||
      citation.endUtf16 !== citation.startUtf16 ||
      citation.endUtf16 > input.content.length
    ) {
      throw new ExternalCitationValidationError("invalid-evidence");
    }
    const title = normalizeExternalTitle(citation.title);
    const url = normalizeExternalUrl(citation.url);
    const excerptStart = Math.max(
      0,
      citation.startUtf16 - EXTERNAL_EVIDENCE_BEFORE_CHARACTERS,
    );
    const excerptEnd = Math.min(
      input.content.length,
      citation.endUtf16 + EXTERNAL_EVIDENCE_AFTER_CHARACTERS,
    );
    const excerpt = {
      before: input.content.slice(excerptStart, citation.startUtf16),
      after: input.content.slice(citation.endUtf16, excerptEnd),
      truncatedBefore: excerptStart > 0,
      truncatedAfter: excerptEnd < input.content.length,
    };
    const provenance = {
      owner: input.owner,
      ownerId: input.ownerId,
      ordinal: citation.ordinal,
      startUtf16: citation.startUtf16,
      endUtf16: citation.endUtf16,
    } as ExternalCitationProvenance;
    const existing = byOrdinal.get(citation.ordinal);
    if (existing) {
      if (existing.title !== title || existing.url !== url) {
        throw new ExternalCitationValidationError("inconsistent-evidence");
      }
      existing.excerpts.push(excerpt);
      existing.provenance.push(provenance);
      continue;
    }
    if (seenUrls.has(url)) {
      throw new ExternalCitationValidationError("duplicate-evidence");
    }
    const alias = `W${citation.ordinal}`;
    byOrdinal.set(citation.ordinal, {
      alias,
      title,
      url,
      excerpts: [excerpt],
      provenance: [provenance],
    });
    seenUrls.add(url);
  }
  const evidence = [...byOrdinal.values()];
  if (
    evidence.length < 1 ||
    evidence.some(({ alias }, index) => alias !== `W${index + 1}`)
  ) {
    throw new ExternalCitationValidationError("invalid-evidence");
  }
  return evidence;
}

export function mergeExternalCitationEvidence(
  groups: readonly (readonly ExternalCitationEvidence[])[],
) {
  const byUrl = new Map<string, ExternalCitationEvidence>();
  let occurrenceCount = 0;
  for (const group of groups) {
    for (let index = 0; index < group.length; index += 1) {
      const source = group[index]!;
      if (
        source.alias !== `W${index + 1}` ||
        source.excerpts.length !== source.provenance.length ||
        source.provenance.length < 1
      ) {
        throw new ExternalCitationValidationError("invalid-evidence");
      }
      const title = normalizeExternalTitle(source.title);
      const url = normalizeExternalUrl(source.url);
      occurrenceCount += source.provenance.length;
      if (occurrenceCount > MAX_EXTERNAL_CITATION_OCCURRENCES) {
        throw new ExternalCitationValidationError("invalid-count");
      }
      const existing = byUrl.get(url);
      if (existing) {
        existing.excerpts.push(...source.excerpts);
        existing.provenance.push(...source.provenance);
        continue;
      }
      if (byUrl.size >= MAX_EXTERNAL_CITATION_SOURCES) {
        throw new ExternalCitationValidationError("too-many-sources");
      }
      byUrl.set(url, {
        alias: "",
        title,
        url,
        excerpts: [...source.excerpts],
        provenance: [...source.provenance],
      });
    }
  }
  return [...byUrl.values()].map((source, index) => ({
    ...source,
    alias: `W${index + 1}`,
  }));
}

export function mergeExternalCitationEvidenceBounded(
  groups: readonly (readonly ExternalCitationEvidence[])[],
) {
  const byUrl = new Map<string, ExternalCitationEvidence>();
  let occurrenceCount = 0;
  for (const group of groups) {
    for (let index = 0; index < group.length; index += 1) {
      const source = group[index]!;
      if (
        source.alias !== `W${index + 1}` ||
        source.excerpts.length !== source.provenance.length ||
        source.provenance.length < 1
      ) {
        throw new ExternalCitationValidationError("invalid-evidence");
      }
      const title = normalizeExternalTitle(source.title);
      const url = normalizeExternalUrl(source.url);
      const remainingOccurrences = MAX_EXTERNAL_CITATION_OCCURRENCES - occurrenceCount;
      if (remainingOccurrences < 1) continue;
      const retainedCount = Math.min(remainingOccurrences, source.provenance.length);
      const retainedExcerpts = source.excerpts.slice(0, retainedCount);
      const retainedProvenance = source.provenance.slice(0, retainedCount);
      const existing = byUrl.get(url);
      if (existing) {
        existing.excerpts.push(...retainedExcerpts);
        existing.provenance.push(...retainedProvenance);
        occurrenceCount += retainedCount;
        continue;
      }
      if (byUrl.size >= MAX_EXTERNAL_CITATION_SOURCES) continue;
      byUrl.set(url, {
        alias: "",
        title,
        url,
        excerpts: retainedExcerpts,
        provenance: retainedProvenance,
      });
      occurrenceCount += retainedCount;
    }
  }
  return [...byUrl.values()].map((source, index) => ({
    ...source,
    alias: `W${index + 1}`,
  }));
}

export function toExternalResearchEvidence(
  evidence: readonly ExternalCitationEvidence[],
) {
  return evidence.map(({ alias, excerpts }) => ({
    alias,
    excerpts: excerpts.map((excerpt) => ({
      supportedTextBeforeCitation:
        `${excerpt.truncatedBefore ? "…" : ""}${excerpt.before}`,
      followingContext: `${excerpt.after}${excerpt.truncatedAfter ? "…" : ""}`,
    })),
  }));
}

export function normalizeExternalUrl(value: string) {
  const candidate = value.trim();
  if (candidate.length < 1 || candidate.length > MAX_EXTERNAL_CITATION_URL_LENGTH) {
    throw new ExternalCitationValidationError("invalid-url");
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ExternalCitationValidationError("invalid-url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ExternalCitationValidationError("invalid-url");
  }
  url.hash = "";
  const normalized = url.toString();
  if (normalized.length > MAX_EXTERNAL_CITATION_URL_LENGTH) {
    throw new ExternalCitationValidationError("invalid-url");
  }
  return normalized;
}

export function normalizeExternalCitationAnnotations(input: {
  content: string;
  annotations: readonly ProviderUrlCitation[];
}): { content: string; citations: ExternalCitationView[] } {
  if (
    input.annotations.length < 1 ||
    input.annotations.length > MAX_EXTERNAL_CITATION_OCCURRENCES
  ) {
    throw new ExternalCitationValidationError("invalid-count");
  }

  const annotations = input.annotations.map((annotation) => {
    if (
      annotation.type !== "url_citation" ||
      !Number.isSafeInteger(annotation.start_index) ||
      !Number.isSafeInteger(annotation.end_index) ||
      annotation.start_index < 0 ||
      annotation.end_index <= annotation.start_index ||
      annotation.end_index > input.content.length
    ) {
      throw new ExternalCitationValidationError("invalid-location");
    }
    return {
      start: annotation.start_index,
      end: annotation.end_index,
      title: normalizeExternalTitle(annotation.title),
      url: normalizeExternalUrl(annotation.url),
    };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  const distinctRanges: Array<{ start: number; end: number }> = [];
  for (const annotation of annotations) {
    const prior = distinctRanges.at(-1);
    if (prior && annotation.start < prior.end) {
      if (annotation.start !== prior.start || annotation.end !== prior.end) {
        throw new ExternalCitationValidationError("overlapping-location");
      }
      continue;
    }
    distinctRanges.push({ start: annotation.start, end: annotation.end });
  }

  let cleanContent = "";
  let rawCursor = 0;
  const insertionByRange = new Map<string, number>();
  for (const range of distinctRanges) {
    cleanContent += input.content.slice(rawCursor, range.start);
    insertionByRange.set(`${range.start}:${range.end}`, cleanContent.length);
    rawCursor = range.end;
  }
  cleanContent += input.content.slice(rawCursor);
  if (cleanContent.trim().length < 1) {
    throw new ExternalCitationValidationError("empty-content");
  }

  const sourceByUrl = new Map<string, { ordinal: number; title: string }>();
  const seenOccurrences = new Set<string>();
  const citations: ExternalCitationView[] = [];
  for (const annotation of annotations) {
    let source = sourceByUrl.get(annotation.url);
    if (source === undefined) {
      const ordinal = sourceByUrl.size + 1;
      if (ordinal > MAX_EXTERNAL_CITATION_SOURCES) {
        throw new ExternalCitationValidationError("too-many-sources");
      }
      source = { ordinal, title: annotation.title };
      sourceByUrl.set(annotation.url, source);
    }
    const offset = insertionByRange.get(`${annotation.start}:${annotation.end}`);
    if (offset === undefined) {
      throw new ExternalCitationValidationError("invalid-location");
    }
    const occurrenceKey = `${source.ordinal}:${offset}`;
    if (seenOccurrences.has(occurrenceKey)) continue;
    seenOccurrences.add(occurrenceKey);
    citations.push({
      kind: "external",
      ordinal: source.ordinal,
      startUtf16: offset,
      endUtf16: offset,
      title: source.title,
      url: annotation.url,
    });
  }

  return { content: cleanContent, citations };
}

export function normalizeExternalCitationMentions(input: {
  content: string;
  mentions: readonly ExternalCitationMention[];
  evidence: readonly ExternalCitationSource[];
}): ExternalCitationView[] {
  if (
    input.mentions.length > MAX_EXTERNAL_CITATION_OCCURRENCES ||
    input.evidence.length > MAX_EXTERNAL_CITATION_SOURCES
  ) {
    throw new ExternalCitationValidationError("invalid-count");
  }
  const evidenceByAlias = new Map<string, ExternalCitationSource>();
  const evidenceUrls = new Set<string>();
  for (let index = 0; index < input.evidence.length; index += 1) {
    const source = input.evidence[index]!;
    const alias = `W${index + 1}`;
    const title = normalizeExternalTitle(source.title);
    const url = normalizeExternalUrl(source.url);
    if (
      source.alias !== alias ||
      evidenceByAlias.has(alias) ||
      evidenceUrls.has(url)
    ) {
      throw new ExternalCitationValidationError("invalid-evidence");
    }
    evidenceByAlias.set(alias, { alias, title, url });
    evidenceUrls.add(url);
  }
  if (input.mentions.length > 0 && evidenceByAlias.size === 0) {
    throw new ExternalCitationValidationError("invalid-evidence");
  }

  const located = input.mentions.map((mention, index) => {
    const evidence = evidenceByAlias.get(mention.sourceAlias);
    const start = input.content.indexOf(mention.citedText);
    if (
      !evidence ||
      start < 0 ||
      input.content.indexOf(mention.citedText, start + mention.citedText.length) >= 0
    ) {
      throw new ExternalCitationValidationError("invalid-mention");
    }
    return {
      evidence,
      index,
      offset: start + mention.citedText.length,
    };
  }).sort((left, right) => left.offset - right.offset || left.index - right.index);

  const ordinalByUrl = new Map<string, number>();
  const seenOccurrences = new Set<string>();
  const citations: ExternalCitationView[] = [];
  for (const mention of located) {
    let ordinal = ordinalByUrl.get(mention.evidence.url);
    if (ordinal === undefined) {
      ordinal = ordinalByUrl.size + 1;
      ordinalByUrl.set(mention.evidence.url, ordinal);
    }
    const occurrenceKey = `${ordinal}:${mention.offset}`;
    if (seenOccurrences.has(occurrenceKey)) continue;
    seenOccurrences.add(occurrenceKey);
    citations.push({
      kind: "external",
      ordinal,
      startUtf16: mention.offset,
      endUtf16: mention.offset,
      title: mention.evidence.title,
      url: mention.evidence.url,
    });
  }
  return citations;
}

export function requireNonOverlappingSynthesisCitations(input: {
  external: readonly Pick<ExternalCitationView, "startUtf16">[];
  internal: ReadonlyArray<{ startUtf16: number; endUtf16: number }>;
}) {
  if (input.external.some((external) =>
    input.internal.some((internal) =>
      external.startUtf16 >= internal.startUtf16 &&
      external.startUtf16 < internal.endUtf16
    )
  )) {
    throw new ExternalCitationValidationError("overlapping-mention");
  }
}
