import "server-only";

export type ContextBudgetArtifact = {
  id: string;
  content: string;
  weight: number;
};

export type FittedContext = {
  content: string;
  artifactContent: ReadonlyMap<string, string>;
  truncatedArtifactIds: ReadonlySet<string>;
};

export class ContextBudgetError extends Error {
  constructor(public readonly reason: "invalid-budget" | "minimum-too-large") {
    super(reason);
    this.name = "ContextBudgetError";
  }
}

export function truncateContextArtifact(content: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ContextBudgetError("invalid-budget");
  }
  if (content.length <= limit) return content;
  return content.slice(0, limit);
}

/**
 * Fits untrusted text artifacts into an exact rendered-character ceiling.
 *
 * Fixed structure is supplied by `render`, so callers can preserve titles,
 * ordinals, aliases, and state labels even when every variable artifact is
 * reduced to an empty string. The render callback receives a trusted set of
 * truncated artifact identifiers so it can serialize truncation separately
 * from untrusted content. Integer weights control the fair share of remaining
 * space without making the result depend on iteration order or provider
 * tokenization.
 */
export function fitContextArtifacts(input: {
  artifacts: readonly ContextBudgetArtifact[];
  maxCharacters: number;
  render: (
    artifactContent: ReadonlyMap<string, string>,
    truncatedArtifactIds: ReadonlySet<string>,
  ) => string;
}): FittedContext {
  if (!Number.isSafeInteger(input.maxCharacters) || input.maxCharacters < 0) {
    throw new ContextBudgetError("invalid-budget");
  }
  const ids = new Set<string>();
  for (const artifact of input.artifacts) {
    if (
      artifact.id.length === 0 ||
      ids.has(artifact.id) ||
      !Number.isSafeInteger(artifact.weight) ||
      artifact.weight < 1
    ) {
      throw new ContextBudgetError("invalid-budget");
    }
    ids.add(artifact.id);
  }

  const renderAtScale = (scale: number) => {
    const artifactContent = new Map<string, string>();
    const truncatedArtifactIds = new Set<string>();
    for (const artifact of input.artifacts) {
      const weightedLimit = scale * artifact.weight;
      const content = truncateContextArtifact(artifact.content, weightedLimit);
      artifactContent.set(artifact.id, content);
      if (content !== artifact.content) truncatedArtifactIds.add(artifact.id);
    }
    return {
      content: input.render(artifactContent, truncatedArtifactIds),
      artifactContent,
      truncatedArtifactIds,
    };
  };

  const complete = new Map(input.artifacts.map(({ id, content }) => [id, content]));
  const completeContent = input.render(complete, new Set());
  if (completeContent.length <= input.maxCharacters) {
    return {
      content: completeContent,
      artifactContent: complete,
      truncatedArtifactIds: new Set(),
    };
  }

  const minimum = renderAtScale(0);
  if (minimum.content.length > input.maxCharacters) {
    throw new ContextBudgetError("minimum-too-large");
  }

  let low = 0;
  let high = input.artifacts.reduce(
    (largest, artifact) => Math.max(largest, Math.ceil(artifact.content.length / artifact.weight)),
    0,
  );
  let fitted = minimum;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderAtScale(middle);
    if (candidate.content.length <= input.maxCharacters) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}
