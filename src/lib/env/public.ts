export type PublicEnvironment = Readonly<Record<never, never>>;

export function getPublicEnvironment(): PublicEnvironment {
  return Object.freeze({});
}
