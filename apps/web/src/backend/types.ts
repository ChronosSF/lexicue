import type {
  BatchListResponse,
  BatchResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateUploadsRequest,
  CreateUploadsResponse,
  LanguagesResponse,
  MeResponse,
  PricingResponse,
  TopUpRequest,
  TopUpResponse,
  UploadTarget,
} from "@subtitle-translator/shared";

/**
 * One interface, two implementations: the mock backend runs the whole product
 * in the browser, and the real one is the same calls against `/api/*` with a
 * Cognito token. The UI never learns which it is talking to, apart from the
 * demo controls below, which only the mock offers.
 */

/** Who is signed in. In the deployed system this comes from the Cognito token. */
export interface Session {
  userId: string;
  email: string;
  /** Verification is what grants the $2.50 free balance (spec section 2.1). */
  emailVerified: boolean;
}

/** A sample subtitle file the demo offers so nobody has to hunt for an SRT. */
export interface SampleFile {
  path: string;
  fileName: string;
  title: string;
  description: string;
  format: string;
  sourceLanguage: string;
  cues: number;
  /** Set on the file that deliberately fails, to demonstrate the refund. */
  fails?: boolean;
}

/** What the demo adds on top of the product: samples and a reset. */
export interface DemoControls {
  listSamples: () => Promise<SampleFile[]>;
  loadSample: (path: string) => Promise<{ fileName: string; bytes: Uint8Array }>;
  /** Throws away the stored demo state and seeds it again. */
  reset: () => Promise<void>;
}

export interface BackendAdapter {
  readonly kind: "mock" | "real";

  /** Cognito in the real adapter; a fake sign-in in the mock. */
  getSession: () => Promise<Session | null>;
  signIn: (input: { email: string }) => Promise<Session>;
  /** Stands in for following the link in the verification email. */
  verifyEmail: () => Promise<Session>;
  signOut: () => Promise<void>;

  /** `GET /api/me` */
  getMe: () => Promise<MeResponse>;
  /** `GET /api/pricing` */
  getPricing: () => Promise<PricingResponse>;
  /** `GET /api/languages` */
  getLanguages: () => Promise<LanguagesResponse>;

  /** `POST /api/uploads` */
  createUploads: (request: CreateUploadsRequest) => Promise<CreateUploadsResponse>;
  /** The presigned POST itself: bytes go straight to storage, never through the API. */
  putUpload: (target: UploadTarget, bytes: Uint8Array) => Promise<void>;

  /** `POST /api/batches`; throws `ApiError` with 402, 422 or 429. */
  createBatch: (request: CreateBatchRequest) => Promise<CreateBatchResponse>;
  /** `GET /api/batches/{id}` */
  getBatch: (batchId: string) => Promise<BatchResponse>;
  /** `GET /api/batches` */
  listBatches: () => Promise<BatchListResponse>;
  /** `DELETE /api/batches/{id}` */
  deleteBatch: (batchId: string) => Promise<void>;

  /** `POST /api/billing/topup` */
  createTopUp: (request: TopUpRequest) => Promise<TopUpResponse>;
  /**
   * Confirming the checkout. In the deployed system Stripe's webhook credits
   * the balance and the SPA only polls `/api/me`; the mock has no webhook, so
   * its own checkout page calls this instead.
   */
  completeCheckout: (sessionId: string) => Promise<void>;

  /** `DELETE /api/me` */
  deleteAccount: () => Promise<void>;

  /** Present only in mock mode. */
  readonly demo: DemoControls | null;
}
