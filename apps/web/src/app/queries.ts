import {
  isBatchRunning,
  type Batch,
  type BatchSummary,
  type CreateBatchRequest,
  type LanguagesResponse,
  type MeResponse,
  type PricingResponse,
  type TopUpResponse,
} from "@subtitle-translator/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useBackend } from "./backend.js";
import type { Session } from "../backend/types.js";

/**
 * Every call to the backend, in one place. The polling intervals come from the
 * response itself (`pollAfterMs`), so the two-seconds-fast, thirty-seconds-
 * economy rule of spec section 7.3 is the backend's decision, not the UI's.
 */

export const keys = {
  session: ["session"] as const,
  me: ["me"] as const,
  pricing: ["pricing"] as const,
  languages: ["languages"] as const,
  batches: ["batches"] as const,
  batch: (batchId: string) => ["batch", batchId] as const,
};

export function useSession(): UseQueryResult<Session | null> {
  const backend = useBackend();
  return useQuery({ queryKey: keys.session, queryFn: () => backend.getSession() });
}

export function useMe(enabled = true): UseQueryResult<MeResponse> {
  const backend = useBackend();
  return useQuery({ queryKey: keys.me, queryFn: () => backend.getMe(), enabled });
}

export function usePricing(): UseQueryResult<PricingResponse> {
  const backend = useBackend();
  return useQuery({
    queryKey: keys.pricing,
    queryFn: () => backend.getPricing(),
    staleTime: 10 * 60 * 1000,
  });
}

export function useLanguages(): UseQueryResult<LanguagesResponse> {
  const backend = useBackend();
  return useQuery({
    queryKey: keys.languages,
    queryFn: () => backend.getLanguages(),
    staleTime: 60 * 60 * 1000,
  });
}

/** Polls while anything in the batch can still change, and then stops. */
export function useBatch(batchId: string | null): UseQueryResult<Batch> {
  const backend = useBackend();
  return useQuery({
    queryKey: keys.batch(batchId ?? "none"),
    queryFn: async () => (await backend.getBatch(batchId ?? "")).batch,
    enabled: batchId !== null,
    refetchInterval: (query) => {
      const batch = query.state.data;
      if (batch === undefined) return false;
      return isBatchRunning(batch) ? batch.pollAfterMs : false;
    },
  });
}

export function useHistory(enabled = true): UseQueryResult<BatchSummary[]> {
  const backend = useBackend();
  return useQuery({
    queryKey: keys.batches,
    queryFn: async () => (await backend.listBatches()).batches,
    enabled,
  });
}

export function useSignIn(): UseMutationResult<Session, Error, { email: string }> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string }) => backend.signIn(input),
    onSuccess: async (session) => {
      client.setQueryData(keys.session, session);
      await client.invalidateQueries();
    },
  });
}

export function useVerifyEmail(): UseMutationResult<Session, Error, void> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => backend.verifyEmail(),
    onSuccess: async (session) => {
      client.setQueryData(keys.session, session);
      await client.invalidateQueries();
    },
  });
}

export function useSignOut(): UseMutationResult<void, Error, void> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => backend.signOut(),
    onSuccess: async () => {
      client.setQueryData(keys.session, null);
      await client.invalidateQueries();
    },
  });
}

export interface CreateBatchInput extends Omit<CreateBatchRequest, "uploadIds"> {
  files: { fileName: string; bytes: Uint8Array }[];
}

/**
 * The upload of spec section 2.1 end to end: ask for the presigned targets,
 * send the bytes, then create the batch, which is what prices and charges.
 */
export function useCreateBatch(): UseMutationResult<Batch, Error, CreateBatchInput> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBatchInput) => {
      const targets = await backend.createUploads({
        files: input.files.map((file) => ({
          fileName: file.fileName,
          byteLength: file.bytes.length,
        })),
      });
      await Promise.all(
        targets.uploads.map((target, index) =>
          backend.putUpload(target, input.files[index]?.bytes ?? new Uint8Array()),
        ),
      );
      const created = await backend.createBatch({
        uploadIds: targets.uploads.map((target) => target.uploadId),
        targetLanguage: input.targetLanguage,
        lane: input.lane,
        options: input.options,
      });
      return created.batch;
    },
    onSuccess: async (batch) => {
      client.setQueryData(keys.batch(batch.batchId), batch);
      await client.invalidateQueries({ queryKey: keys.me });
      await client.invalidateQueries({ queryKey: keys.batches });
    },
  });
}

export function useTopUp(): UseMutationResult<TopUpResponse, Error, { amountCents: number }> {
  const backend = useBackend();
  return useMutation({
    mutationFn: (input: { amountCents: number }) => backend.createTopUp(input),
  });
}

export function useCompleteCheckout(): UseMutationResult<void, Error, string> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => backend.completeCheckout(sessionId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useDeleteBatchFiles(): UseMutationResult<void, Error, string> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => backend.deleteBatch(batchId),
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });
}

export function useResetDemo(): UseMutationResult<void, Error, void> {
  const backend = useBackend();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await backend.demo?.reset();
    },
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });
}
