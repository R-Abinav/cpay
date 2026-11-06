// Generate the Agent Pass approval key pair (our operational Ed25519 key, never a user key).
// Prints to your terminal only: put the secret in AGENT_PASS_APPROVAL_SECRET_KEY (cpay-web, server-side)
// and the public key in NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY.
import { randomBytes } from "node:crypto";
import { approvalPublicKeyHex } from "../src/agent-pass.js";

const sk = randomBytes(32).toString("hex");
console.log(`AGENT_PASS_APPROVAL_SECRET_KEY=${sk}`);
console.log(`NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY=${approvalPublicKeyHex(sk)}`);
