import {
  MAX_EXTERNAL_CITATION_OCCURRENCES,
  MAX_EXTERNAL_CITATION_SOURCES,
  MAX_EXTERNAL_CITATION_TITLE_LENGTH,
  MAX_EXTERNAL_CITATION_URL_LENGTH,
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

function normalizeExternalTitle(value: string) {
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
