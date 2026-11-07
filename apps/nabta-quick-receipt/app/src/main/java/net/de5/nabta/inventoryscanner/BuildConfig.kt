package net.de5.nabta.inventoryscanner

/** Compatibility constant for the shared data and scanner layer.
 * The quick-receipt application has its own generated BuildConfig in its
 * application namespace; this keeps the shared inventory UI source inert but
 * compilable without embedding a secret or a private origin. */
object BuildConfig {
  const val DEFAULT_API_URL = "https://nabta-inventory-scanner-relay.mahmoudnabih989.workers.dev"
}
