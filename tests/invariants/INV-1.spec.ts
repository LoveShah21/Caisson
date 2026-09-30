/**
 * INV-1. No secret in the guest.
 *
 * The KVM-only implementation lives beside the Firecracker mechanism tests
 * because it owns real-vsock fixture setup. Importing it here makes it an
 * invariant test without creating a second guest run or a second secret path.
 */
import "../isolation/firecracker-live-broker.integration.spec.js";
