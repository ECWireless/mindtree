import { z } from "zod";

export const MAX_INTERNAL_CITATIONS = 32;
export const MAX_CITED_TEXT_LENGTH = 160;

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
