import { z } from "zod";

export const MAX_INTERNAL_CITATIONS = 32;
export const MAX_EXTERNAL_CITATION_SOURCES = 32;
export const MAX_EXTERNAL_CITATION_OCCURRENCES = 64;
export const MAX_CITED_TEXT_LENGTH = 160;
export const MAX_EXTERNAL_CITATION_TITLE_LENGTH = 500;
export const MAX_EXTERNAL_CITATION_URL_LENGTH = 2_048;

const unsupportedInternalLinkPhrase = /[\t\r\n*_\\`]/;
const markdownBlockPrefix = /^(?: {0,3}(?:#{1,6}|[-+>]|\d{1,9}[.)])[ \t]| {4}|~{3})/;

export const internalCitationMentionSchema = z.object({
  evidenceAlias: z.string().regex(/^E[1-9][0-9]*$/).max(8),
  citedText: z
    .string()
    .min(1)
    .max(MAX_CITED_TEXT_LENGTH)
    .refine((text) => text.trim() === text)
    .refine((text) => !unsupportedInternalLinkPhrase.test(text))
    .refine((text) => !markdownBlockPrefix.test(text)),
}).strict();

export type InternalCitationMention = z.infer<typeof internalCitationMentionSchema>;

export type InternalCitationView = {
  kind: "internal";
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  snapshot: {
    nodeId: string;
    title: string;
    synthesisVersionId: string;
  };
  target:
    | {
        state: "available";
        nodeId: string;
        title: string;
        synthesisVersionId: string;
        renamed: boolean;
        moved: boolean;
        archived: boolean;
        changedRevision: boolean;
      }
    | { state: "unavailable"; deletedAt: string };
};

export type ExternalCitationView = {
  kind: "external";
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  title: string;
  url: string;
};
