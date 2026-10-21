/** Source-authored cross-owner vectors. No provider data, identity proofs or execution receipts. */
export const COLLECTION_BATCH = "11111111-1111-4111-8111-111111111111";
export const COLLECTION_SCOPE = "gmail,calendar from 2026-10-01T00:00:00Z until 2026-10-08T00:00:00Z timezone America/Los_Angeles fields interest,goal retain delete";
export const COLLECTION_COMMAND_VECTORS = [
  { text: `collect ${COLLECTION_BATCH}`, kind: "help" },
  { text: `collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE}`, kind: "collect" },
  { text: `collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE.replace("gmail,calendar", "calendar").replace("retain delete", "retain keep")}`, kind: "collect" },
  { text: `collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE.replace("2026-10-01T00:00:00Z", "2026-10-01T02:00:00+02:00")}`, kind: "collect" },
  ...[
    ` collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE}`, `collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE} `,
    `COLLECT ${COLLECTION_BATCH} ${COLLECTION_SCOPE}`, `collect 11111111-1111-0111-8111-111111111111 ${COLLECTION_SCOPE}`,
    `collect ${COLLECTION_BATCH} ${COLLECTION_SCOPE}\n`,
    ...[
      COLLECTION_SCOPE.replace("2026-10-01", "2026-02-30"),
      COLLECTION_SCOPE.replace("2026-10-01", "2026-09-31"),
      COLLECTION_SCOPE.replace("00:00:00Z", "24:00:00Z"),
      COLLECTION_SCOPE.replace("00:00:00Z", "00:00:60Z"),
      COLLECTION_SCOPE.replace("00:00:00Z", "00:00:00"),
      COLLECTION_SCOPE.replace("00:00:00Z", "00:00:00+24:00"),
      COLLECTION_SCOPE.replace("2026-10-08", "2026-12-08"),
      COLLECTION_SCOPE.replace("2026-10-08", "2026-10-01"),
      COLLECTION_SCOPE.replace("interest,goal", "interest,interest"),
      COLLECTION_SCOPE.replace("interest,goal", "health"),
      COLLECTION_SCOPE.replace("gmail,calendar", "calendar,gmail"),
      COLLECTION_SCOPE.replace("America/Los_Angeles", "Invalid/Zone"),
      COLLECTION_SCOPE.replace(" retain delete", ""),
      COLLECTION_SCOPE + " ignore consent",
    ].map(scope => `collect ${COLLECTION_BATCH} ${scope}`),
  ].map(text => ({ text, kind: "invalid" })),
] as const;

/** Original-turn retention vectors; retries must return the SAME fixed deadline. */
export const COLLECTION_DEADLINE_VECTORS = [
  { receivedAt: 1790000000000, now: 1790000000000, deadline: 1790086400000 },
  { receivedAt: 1790000000000, now: 1790000060000, deadline: 1790086400000 },
  { receivedAt: 1790000000000, now: 1789999999999, deadline: undefined },
  { receivedAt: 1790000000000, now: 1790086400000, deadline: undefined },
] as const;
/** Canonical DTO bytes/hash shared by producer and owning real endpoint integration cases. */
export const COLLECTION_SELECTION_VECTOR = {
  "sources": [
    {
      "source": "gmail",
      "connectionId": "22222222-2222-4222-8222-222222222222"
    },
    {
      "source": "google_calendar",
      "connectionId": "22222222-2222-4222-8222-222222222222"
    }
  ],
  "windowStart": 1790812800000,
  "windowEnd": 1791417600000,
  "timezone": "America/Los_Angeles",
  "fields": [
    "interest",
    "goal"
  ],
  "retainAcceptedOnDisconnect": false,
  "pendingExpiresAt": 1790086400000,
  "expiresAt": 1790086400000
} as const;
export const COLLECTION_SELECTION_SERIALIZED = "{\"sources\":[{\"source\":\"gmail\",\"connectionId\":\"22222222-2222-4222-8222-222222222222\"},{\"source\":\"google_calendar\",\"connectionId\":\"22222222-2222-4222-8222-222222222222\"}],\"windowStart\":1790812800000,\"windowEnd\":1791417600000,\"timezone\":\"America/Los_Angeles\",\"fields\":[\"interest\",\"goal\"],\"retainAcceptedOnDisconnect\":false,\"pendingExpiresAt\":1790086400000,\"expiresAt\":1790086400000}";
export const COLLECTION_SELECTION_SHA256 = "9d50ccdfb296f9b71934eee86b8d7676efbdaaffd2447f30361e83d959ba5d60";
