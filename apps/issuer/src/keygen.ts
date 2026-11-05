// pnpm --filter @cpay/issuer keygen: prints a fresh BBS issuer key pair (base64).
// Put the secret key in ISSUER_BBS_SECRET_KEY; the public key is also served at GET /issuer-key.
import { issuerKeygen } from "@cpay/credential";

const { secretKey, publicKey } = await issuerKeygen();
console.log(`ISSUER_BBS_SECRET_KEY=${secretKey}`);
console.log(`# public key (served at GET /issuer-key): ${publicKey}`);
