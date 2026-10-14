# Safe Blooio OTP failure diagnostics

A real isolated staging signup reached the code-entry screen, but the backend did not confirm the provider send. No new code was observed. The provider account and line reads succeeded. The OTP error handler discarded the existing failure class and HTTP status, so the failure could not be classified.

The change retains only an allowlisted `ChannelSendError.failure` and an integer HTTP status from 100 to 599. Other errors report `unknown` and `none`. It never logs the provider message, cause, raw provider code, request, recipient, verification code, or API key. It does not retry, fall back, accept an uncertain receipt, or change public authentication responses.

## Validation

Bun 1.4.2, TypeScript 5.9.3. The existing HTTP/Postgres integration uses its own temporary local database and a local HTTP provider. It makes no external provider or model requests.

```sh
OBSERVATORY_PG_DIR=<existing-local-cluster> REQUIRE_PG=1 bun test --conditions eliza-source --timeout 120000 packages/platform/test/blooio-otp.integration.test.ts
bun run typecheck
bun run sim
```

- Before: the diagnostic assertion fails with the original source. Five cases pass and one fails.
- After: six tests pass, zero fail, with 144 assertions. All six failed-send modes retain no usable challenge and make one provider request.
- The test checks the complete diagnostic line and verifies that code, phone and key canaries are absent.
- The normal root and sites typecheck pass. Initial missing Observatory dependency declarations were resolved by using the existing declared dependencies; no source or compiler settings were narrowed.
- The full normal simulation passed 326/326 blocking gates in 351.8 seconds. Fourteen existing tracked targets remain off target. This does not establish live delivery or matching readiness.

Independent source review found no privacy or scope issue. Initial incorrect test expectations for the existing blocked/403 classification and missing-ID/200 response were corrected; those failures are retained privately.

This is an observability fix. It does not identify or fix the original provider failure. A real staged retry is required after release. Production was not changed for this investigation.
