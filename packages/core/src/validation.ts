import { ApiError } from "@lexicue/shared";

/**
 * Request validation against the zod schemas of `@lexicue/shared`, in one
 * place so every route fails the same way.
 *
 * A body that does not match the contract is the client's mistake, so it is a
 * 400 carrying the schema's own complaint, never a 500. The schemas themselves
 * live in `@lexicue/shared` because the app builds its requests from the same
 * ones; this is only the part that decides what a mismatch means.
 */
export function validateRequest<T>(schema: { parse: (input: unknown) => T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw new ApiError({
      code: "bad-request",
      message: `That request did not match the API contract. ${
        error instanceof Error ? error.message : ""
      }`.trim(),
    });
  }
}
